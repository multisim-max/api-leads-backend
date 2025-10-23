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

// --- LÓGICA DO KOMMO (ROTAÇÃO DE TOKEN) ---

let kommoAccessToken = null;
let tokenExpiresAt = 0;

// Nova função para LER o token do Banco de Dados
async function getRefreshTokenFromDB() {
  try {
    const result = await pool.query("SELECT valor FROM configuracao WHERE chave = 'KOMMO_REFRESH_TOKEN'");
    if (result.rows.length === 0) {
      throw new Error('KOMMO_REFRESH_TOKEN não encontrado no banco de dados.');
    }
    return result.rows[0].valor;
  } catch (error) {
    console.error('Erro ao LER refresh_token do DB:', error);
    throw error;
  }
}

// Nova função para SALVAR o token no Banco de Dados
async function saveRefreshTokenToDB(newToken) {
  try {
    await pool.query(
      "UPDATE configuracao SET valor = $1 WHERE chave = 'KOMMO_REFRESH_TOKEN'",
      [newToken]
    );
    console.log('Novo refresh_token foi salvo no banco de dados com sucesso.');
  } catch (error) {
    console.error('Erro ao SALVAR novo refresh_token no DB:', error);
  }
}

// Função de autenticação ATUALIZADA
async function getKommoAccessToken() {
  const now = Date.now();
  if (kommoAccessToken && now < tokenExpiresAt) {
    console.log('Usando Access Token do cache do Kommo.');
    return kommoAccessToken;
  }

  console.log('Access Token expirado ou inexistente. Lendo refresh_token do DB...');
  try {
    // 1. LÊ o token do banco
    const currentRefreshToken = await getRefreshTokenFromDB();

    // 2. USA o token para pedir um novo access_token
    const response = await axios.post(`${process.env.KOMMO_SUBDOMAIN}/oauth2/access_token`, {
      client_id: process.env.KOMMO_CLIENT_ID,
      client_secret: process.env.KOMMO_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: currentRefreshToken // Usa o token do banco
    });

    // 3. GUARDA os novos tokens
    kommoAccessToken = response.data.access_token;
    const newRefreshToken = response.data.refresh_token; // O "Token B"
    tokenExpiresAt = Date.now() + (response.data.expires_in - 3600) * 1000; 

    console.log('Novo Access Token do Kommo obtido com sucesso.');

    // 4. SALVA o "Token B" de volta no banco
    // (Não precisamos esperar isso terminar)
    saveRefreshTokenToDB(newRefreshToken);

    return kommoAccessToken;

  } catch (error) {
    console.error('Erro CRÍTICO ao buscar Access Token do Kommo:', error.response ? error.response.data : error.message);
    // Se o token foi revogado, o erro 401 aparecerá aqui.
    // Isso indicará que o token no DB está permanentemente inválido.
    throw new Error('Falha ao autenticar com Kommo.');
  }
}

// (A função createKommoLead não muda, ela apenas usa getKommoAccessToken)
async function createKommoLead(leadData) {
  const { nome, email, telefone, origem } = leadData;
  try {
    const accessToken = await getKommoAccessToken();
    const kommoApi = axios.create({
      baseURL: process.env.KOMMO_SUBDOMAIN,
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
    });
    const tagsParaAdicionar = [];
    if (origem) {
      tagsParaAdicionar.push({ name: origem });
    }
    const payload = [{
      name: `Lead de ${nome} - ${email}`,
      _embedded: {
        ...(tagsParaAdicionar.length > 0 && { tags: tagsParaAdicionar }),
        contacts: [{
          first_name: nome,
          custom_fields_values: [
            { field_code: "EMAIL", values: [{ value: email }] },
            { field_code: "PHONE", values: [{ value: telefone }] }
          ]
        }]
      }
    }];
    const response = await kommoApi.post('/api/v4/leads/complex', payload);
    console.log('Lead complexo (com tags) criado no Kommo:', response.data[0].id);
    return response.data[0].id;
  } catch (error) {
    console.error('Erro ao criar lead no Kommo:', error.response ? error.response.data : error.message);
    if (error.response && error.response.status === 401) {
      kommoAccessToken = null; tokenExpiresAt = 0;
      console.log('Token do Kommo invalidado. Será renovado na próxima chamada.');
    }
  }
}

// --- Rotas da API ---

app.get('/', (req, res) => {
  res.send('VERSÃO 5 DA API. Rotação de Token Implementada. 🚀');
});

// Rota de setup (não muda)
app.get('/setup-db', async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS leads (
        id SERIAL PRIMARY KEY, nome VARCHAR(100), email VARCHAR(100),
        telefone VARCHAR(30), origem VARCHAR(50), dados_formulario JSONB,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    res.status(200).send('Tabela "leads" verificada/criada com sucesso!');
  } catch (error) { console.error('Erro ao criar tabela:', error); res.status(500).send('Erro no servidor ao criar tabela.'); }
});

// --- (NOVO!) ROTAS DE CONFIGURAÇÃO DE TOKEN ---

// ROTA 1: Para criar a tabela de configuração (Execute 1 vez)
app.get('/setup-config-table', async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS configuracao (
        id SERIAL PRIMARY KEY,
        chave VARCHAR(100) UNIQUE NOT NULL,
        valor TEXT NOT NULL,
        atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    res.status(200).send('Tabela "configuracao" verificada/criada com sucesso!');
  } catch (error) {
    console.error('Erro ao criar tabela configuracao:', error);
    res.status(500).send('Erro no servidor ao criar tabela.');
  }
});

// ROTA 2: Para salvar o token inicial (Execute 1 vez com Postman)
app.post('/set-initial-token', async (req, res) => {
  const { token } = req.body;
  if (!token) {
    return res.status(400).send('Token é obrigatório.');
  }

  try {
    // Insere ou atualiza o token
    await pool.query(
      `INSERT INTO configuracao (chave, valor) 
       VALUES ('KOMMO_REFRESH_TOKEN', $1)
       ON CONFLICT (chave) DO UPDATE SET 
       valor = EXCLUDED.valor, 
       atualizado_em = CURRENT_TIMESTAMP`,
      [token]
    );
    res.status(200).send('Refresh Token do Kommo salvo no banco de dados com sucesso!');
  } catch (error) {
    console.error('Erro ao salvar token inicial:', error);
    res.status(500).send('Erro no servidor ao salvar token.');
  }
});

// Rota principal (não muda)
app.post('/submit-lead', async (req, res) => {
  const { nome, email } = req.body;
  if (!nome || !email) {
    return res.status(400).send('Nome e Email são obrigatórios.');
  }
  console.log('Recebendo lead:', nome, email);
  try {
    const result = await pool.query(
      `INSERT INTO leads (nome, email, telefone, origem, dados_formulario) 
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [req.body.nome, req.body.email, req.body.telefone, req.body.origem, req.body]
    );
    const novoLeadId = result.rows[0].id;
    console.log(`Lead #${novoLeadId} salvo no banco.`);
    createKommoLead(req.body).catch(err => console.error('Falha ao enviar lead para Kommo (em background):', err.message));
    console.log('TODO: Enviar para API do Notion');
    res.status(201).json({ 
      message: 'Lead recebido com sucesso!', 
      leadId: novoLeadId 
    });
  } catch (error) {
    console.error('Erro ao processar lead (Banco de Dados):', error);
    res.status(500).send('Erro interno do servidor.');
  }
});

// --- Iniciar o Servidor ---
app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
});