// --- Imports ---
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 8080;

// --- Configuração Essencial ---
app.use(cors({ origin: ['*', '*'] }));
app.use(express.json());

// --- Configuração do Banco de Dados ---
const caCert = fs.readFileSync(
  path.resolve(__dirname, 'ca-cert.crt')
).toString();
const connectionString = process.env.DATABASE_URL;
const cleanedConnectionString = connectionString.split('?')[0];
const pool = new Pool({
  connectionString: cleanedConnectionString, 
  ssl: { ca: caCert }
});

// --- LÓGICA DO KOMMO (ROTAÇÃO DE TOKEN - NÃO MUDA) ---
let kommoAccessToken = null;
let tokenExpiresAt = 0;
async function getRefreshTokenFromDB() {
  try {
    const result = await pool.query("SELECT valor FROM configuracao WHERE chave = 'KOMMO_REFRESH_TOKEN'");
    if (result.rows.length === 0) { throw new Error('KOMMO_REFRESH_TOKEN não encontrado no banco de dados.'); }
    return result.rows[0].valor;
  } catch (error) { console.error('Erro ao LER refresh_token do DB:', error); throw error; }
}
async function saveRefreshTokenToDB(newToken) {
  try {
    await pool.query(
      "UPDATE configuracao SET valor = $1 WHERE chave = 'KOMMO_REFRESH_TOKEN'",
      [newToken]
    );
    console.log('Novo refresh_token foi salvo no banco de dados com sucesso.');
  } catch (error) { console.error('Erro ao SALVAR novo refresh_token no DB:', error); }
}
async function getKommoAccessToken() {
  const now = Date.now();
  if (kommoAccessToken && now < tokenExpiresAt) {
    console.log('Usando Access Token do cache do Kommo.');
    return kommoAccessToken;
  }
  console.log('Access Token expirado ou inexistente. Lendo refresh_token do DB...');
  try {
    const currentRefreshToken = await getRefreshTokenFromDB();
    const response = await axios.post(`${process.env.KOMMO_SUBDOMAIN}/oauth2/access_token`, {
      client_id: process.env.KOMMO_CLIENT_ID,
      client_secret: process.env.KOMMO_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: currentRefreshToken
    });
    kommoAccessToken = response.data.access_token;
    const newRefreshToken = response.data.refresh_token;
    tokenExpiresAt = Date.now() + (response.data.expires_in - 3600) * 1000; 
    console.log('Novo Access Token do Kommo obtido com sucesso.');
    saveRefreshTokenToDB(newRefreshToken);
    return kommoAccessToken;
  } catch (error) {
    console.error('Erro CRÍTICO ao buscar Access Token do Kommo:', error.response ? error.response.data : error.message);
    throw new Error('Falha ao autenticar com Kommo.');
  }
}

// --- LÓGICA DO KOMMO (CRIAÇÃO DE LEAD ATUALIZADA) ---
// Agora a função aceita um 'payload' dinâmico, construído pela nova rota
async function createKommoLead(dynamicPayload) {
  try {
    const accessToken = await getKommoAccessToken();
    const kommoApi = axios.create({
      baseURL: process.env.KOMMO_SUBDOMAIN,
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
    });

    // Envia o payload dinâmico que construímos
    const response = await kommoApi.post('/api/v4/leads/complex', [dynamicPayload]);
    
    console.log('Lead complexo (dinâmico) criado no Kommo:', response.data[0].id);
    return response.data[0]; // Retorna a resposta completa do Kommo

  } catch (error) {
    console.error('Erro ao criar lead no Kommo:', error.response ? error.response.data : error.message);
    if (error.response && error.response.status === 401) {
      kommoAccessToken = null; tokenExpiresAt = 0;
      console.log('Token do Kommo invalidado. Será renovado na próxima chamada.');
    }
    // Lança o erro para que a rota principal possa pegá-lo
    throw error.response ? error.response.data : new Error('Erro desconhecido no Kommo');
  }
}

// --- FUNÇÃO AJUDANTE: PEGAR VALOR ANINHADO ---
// Pega um valor de um JSON, ex: "user.email" de { user: { email: "..." } }
function getNestedValue(obj, path) {
  return path.split('.').reduce((acc, part) => acc && acc[part], obj);
}

// --- ROTA DE SAÚDE ---
app.get('/', (req, res) => {
  res.send('VERSÃO 10 DA API. RRotas de Admin Prontas. 🚀 🚀');
});

// --- (NOVO!) A "SUPER-ROTA" DE INBOUND ---
app.post('/inbound/:source_name', async (req, res) => {
  const { source_name } = req.params;
  const dadosRecebidos = req.body;

  let logId;
  let sourceId;

  try {
    // 1. Encontrar a Fonte no banco de dados
    const sourceResult = await pool.query('SELECT id FROM sources WHERE nome = $1', [source_name]);
    if (sourceResult.rows.length === 0) {
      console.warn(`Fonte "${source_name}" não encontrada.`);
      return res.status(404).send({ error: 'Fonte não encontrada.' });
    }
    sourceId = sourceResult.rows[0].id;

    // 2. Criar o Log Inicial (estado 'pendente')
    const logResult = await pool.query(
      `INSERT INTO request_logs (source_id, estado, dados_recebidos) 
       VALUES ($1, 'pendente', $2) RETURNING id`,
      [sourceId, dadosRecebidos]
    );
    logId = logResult.rows[0].id;
    console.log(`[Log ${logId}] Recebido lead da fonte "${source_name}".`);

    // 3. Buscar as Regras de Mapeamento
    const mappingsResult = await pool.query(
      'SELECT campo_fonte, tipo_campo_kommo, codigo_campo_kommo FROM field_mappings WHERE source_id = $1',
      [sourceId]
    );
    const regras = mappingsResult.rows;
    if (regras.length === 0) {
      console.warn(`[Log ${logId}] Nenhuma regra de mapeamento encontrada para a fonte "${source_name}".`);
      return res.status(400).send({ error: 'Nenhuma regra de mapeamento configurada.' });
    }

    // 4. Construir o Payload Dinâmico do Kommo
    const payloadKommo = {
      name: `Lead da Fonte: ${source_name}`, // Nome padrão
      _embedded: {
        contacts: [{}],
        tags: []
      },
      custom_fields_values: []
    };

    const contato = payloadKommo._embedded.contacts[0];
    
    for (const regra of regras) {
      // Pega o valor do JSON que recebemos (ex: "user.email")
      const valor = getNestedValue(dadosRecebidos, regra.campo_fonte);
      if (!valor) continue; // Pula se o campo não veio no JSON

      switch (regra.tipo_campo_kommo) {
        case 'lead_name':
          payloadKommo.name = valor;
          break;
        case 'contact_first_name':
          contato.first_name = valor;
          break;
        case 'contact_custom_field':
          if (!contato.custom_fields_values) {
            contato.custom_fields_values = [];
          }
          contato.custom_fields_values.push({
            field_code: regra.codigo_campo_kommo,
            values: [{ value: valor }]
          });
          break;
        case 'lead_custom_field':
          payloadKommo.custom_fields_values.push({
            field_code: regra.codigo_campo_kommo,
            values: [{ value: valor }]
          });
          break;
        case 'tag':
          payloadKommo._embedded.tags.push({ name: valor });
          break;
      }
    }
    
    // Ajuste final: se o nome do contato não foi mapeado, usa o lead_name
    if (!contato.first_name && payloadKommo.name) {
      contato.first_name = payloadKommo.name;
    }

    // 5. Enviar ao Kommo
    console.log(`[Log ${logId}] Enviando payload dinâmico para o Kommo...`);
    const respostaKommo = await createKommoLead(payloadKommo);

    // 6. Atualizar o Log para 'sucesso'
    await pool.query(
      "UPDATE request_logs SET estado = 'sucesso', resposta_kommo = $1 WHERE id = $2",
      [respostaKommo, logId]
    );
    console.log(`[Log ${logId}] Sucesso. Lead criado no Kommo: ${respostaKommo.id}`);
    
    // 7. Responder ao formulário
    res.status(201).send({ message: 'Lead recebido e processado com sucesso!', logId: logId });

  } catch (error) {
    // 7.b Atualizar o Log para 'falha'
    console.error(`[Log ${logId || 'N/A'}] Falha no processamento:`, error);
    if (logId) {
      await pool.query(
        "UPDATE request_logs SET estado = 'falha', resposta_kommo = $1 WHERE id = $2",
        [error, logId]
      );
    }
    res.status(500).send({ error: 'Falha ao processar o lead.', logId: logId });
  }
});
// --- (NOVO!) ROTAS DA API DE ADMIN (Para o Widget) ---

// Rota para criar uma nova fonte
app.post('/api/sources', async (req, res) => {
  const { nome, tipo = 'webhook' } = req.body;
  if (!nome) {
    return res.status(400).send({ error: 'O "nome" da fonte é obrigatório.' });
  }
  try {
    const result = await pool.query(
      'INSERT INTO sources (nome, tipo) VALUES ($1, $2) RETURNING *',
      [nome, tipo]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao criar source:', error);
    res.status(500).send({ error: 'Erro ao criar fonte.' });
  }
});

// Rota para criar/atualizar os mapeamentos de uma fonte
app.post('/api/mappings', async (req, res) => {
  const { source_id, mappings } = req.body;
  if (!source_id || !mappings || !Array.isArray(mappings)) {
    return res.status(400).send({ error: 'Estrutura de dados inválida.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. (Opcional) Limpa os mapeamentos antigos desta fonte
    // await client.query('DELETE FROM field_mappings WHERE source_id = $1', [source_id]);

    // 2. Insere os novos mapeamentos
    for (const rule of mappings) {
      await client.query(
        `INSERT INTO field_mappings (source_id, campo_fonte, tipo_campo_kommo, codigo_campo_kommo)
         VALUES ($1, $2, $3, $4)`,
        [source_id, rule.campo_fonte, rule.tipo_campo_kommo, rule.codigo_campo_kommo]
      );
    }

    await client.query('COMMIT');
    res.status(201).send({ message: 'Mapeamentos salvos com sucesso.' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao salvar mapeamentos:', error);
    res.status(500).send({ error: 'Erro ao salvar mapeamentos.' });
  } finally {
    client.release();
  }
});

// --- ROTAS DE SETUP ANTIGAS (Manter por segurança) ---
app.get('/setup-db', async (req, res) => { /* ...código antigo... */ 
  try{await pool.query(`CREATE TABLE IF NOT EXISTS leads (id SERIAL PRIMARY KEY, nome VARCHAR(100), email VARCHAR(100), telefone VARCHAR(30), origem VARCHAR(50), dados_formulario JSONB, criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`); res.status(200).send('Tabela "leads" (antiga) verificada/criada com sucesso!');}catch(e){console.error(e);res.status(500).send('Erro');}
});
app.get('/setup-config-table', async (req, res) => { /* ...código antigo... */ 
  try{await pool.query(`CREATE TABLE IF NOT EXISTS configuracao (id SERIAL PRIMARY KEY, chave VARCHAR(100) UNIQUE NOT NULL, valor TEXT NOT NULL, atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`); res.status(200).send('Tabela "configuracao" verificada/criada com sucesso!');}catch(e){console.error(e);res.status(500).send('Erro');}
});
app.post('/set-initial-token', async (req, res) => { /* ...código antigo... */ 
  const { token } = req.body; if (!token) {return res.status(400).send('Token é obrigatório.');} try {await pool.query(`INSERT INTO configuracao (chave, valor) VALUES ('KOMMO_REFRESH_TOKEN', $1) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = CURRENT_TIMESTAMP`, [token]); res.status(200).send('Refresh Token do Kommo salvo no banco de dados com sucesso!');}catch(e){console.error(e);res.status(500).send('Erro');}
});
app.get('/setup-sources-table', async (req, res) => { /* ...código antigo... */ 
  try{await pool.query(`CREATE TABLE IF NOT EXISTS sources (id SERIAL PRIMARY KEY, nome VARCHAR(100) NOT NULL, tipo VARCHAR(50) DEFAULT 'webhook', criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`); await pool.query(`CREATE INDEX IF NOT EXISTS idx_sources_nome ON sources(nome);`); res.status(200).send('Tabela "sources" (fontes) verificada/criada com sucesso!');}catch(e){console.error(e);res.status(500).send('Erro');}
});
app.get('/setup-logs-table', async (req, res) => { /* ...código antigo... */ 
  try{await pool.query(`CREATE TABLE IF NOT EXISTS request_logs (id SERIAL PRIMARY KEY, source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL, estado VARCHAR(20) DEFAULT 'pendente', dados_recebidos JSONB, resposta_kommo JSONB, criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`); await pool.query(`CREATE INDEX IF NOT EXISTS idx_logs_source_id ON request_logs(source_id);`); await pool.query(`CREATE INDEX IF NOT EXISTS idx_logs_estado ON request_logs(estado);`); res.status(200).send('Tabela "request_logs" (registros) verificada/criada com sucesso!');}catch(e){console.error(e);res.status(500).send('Erro');}
});
app.get('/setup-mappings-table', async (req, res) => { /* ...código antigo... */ 
  try{await pool.query(`CREATE TABLE IF NOT EXISTS field_mappings (id SERIAL PRIMARY KEY, source_id INTEGER REFERENCES sources(id) ON DELETE CASCADE, campo_fonte VARCHAR(255) NOT NULL, tipo_campo_kommo VARCHAR(50) NOT NULL, codigo_campo_kommo VARCHAR(255) NOT NULL, criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`); await pool.query(`CREATE INDEX IF NOT EXISTS idx_mappings_source_id ON field_mappings(source_id);`); res.status(200).send('Tabela "field_mappings" (mapeamento) verificada/criada com sucesso!');}catch(e){console.error(e);res.status(500).send('Erro');}
});
// Rota antiga (desativada, mas mantida)
app.post('/submit-lead', async (req, res) => {
  res.status(410).send("Esta rota está desativada. Use /inbound/:source_name");
});

// --- Iniciar o Servidor ---
app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
});