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

// --- Configuração Essencial (ATUALIZADA) ---

// 1. Configura o CORS (MODO SEGURO)
// Adicionamos suas novas URLs do painel admin à lista
const whitelist = [
  'https://www.bairrocostaverde.com.br', // Seu site de formulário
  'http://localhost:3000',             // Para desenvolvimento do seu widget
  'https://asn-asmin-widget.vercel.app', // <-- SUA URL NOVA
  'https://v0-admin-page-design-dexvkykcb-multisim.vercel.app' // <-- SUA OUTRA URL NOVA
];
const corsOptions = {
  origin: function (origin, callback) {
    // Permite apps da lista, apps sem origem (ex: Postman) e o mesmo domínio
    if (whitelist.indexOf(origin) !== -1 || !origin) {
      callback(null, true);
    } else {
      console.warn(`Origem não permitida pelo CORS: ${origin}`);
      callback(new Error('Não permitido pelo CORS'));
    }
  },
  methods: "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS",
  optionsSuccessStatus: 204
};
app.use(cors(corsOptions));
app.use(express.json());

// --- Middleware de Segurança para a API de Admin ---
const checkApiKey = (req, res, next) => {
  const apiKey = req.headers['authorization']; // Espera: "Authorization: Bearer sk_live_..."
  const secret = process.env.ADMIN_API_KEY;

  if (!apiKey || apiKey !== `Bearer ${secret}`) {
    console.warn('Tentativa de acesso não autorizado à API de Admin.');
    return res.status(401).send({ error: 'Não autorizado.' });
  }
  next(); // Chave correta, pode prosseguir
};

// --- Configuração do Banco de Dados ---
// (Sem mudanças aqui... caCert, pool, etc.)
const caCert = fs.readFileSync(path.resolve(__dirname, 'ca-cert.crt')).toString();
const connectionString = process.env.DATABASE_URL;
const cleanedConnectionString = connectionString.split('?')[0];
const pool = new Pool({ connectionString: cleanedConnectionString, ssl: { ca: caCert } });

// --- LÓGICA DO KOMMO (ROTAÇÃO DE TOKEN - NÃO MUDA) ---
// (Sem mudanças aqui... getRefreshTokenFromDB, saveRefreshTokenToDB, getKommoAccessToken)
let kommoAccessToken = null;
let tokenExpiresAt = 0;
async function getRefreshTokenFromDB() { try { const result = await pool.query("SELECT valor FROM configuracao WHERE chave = 'KOMMO_REFRESH_TOKEN'"); if (result.rows.length === 0) { throw new Error('KOMMO_REFRESH_TOKEN não encontrado no banco de dados.'); } return result.rows[0].valor; } catch (error) { console.error('Erro ao LER refresh_token do DB:', error); throw error; } }
async function saveRefreshTokenToDB(newToken) { try { await pool.query("UPDATE configuracao SET valor = $1 WHERE chave = 'KOMMO_REFRESH_TOKEN'", [newToken]); console.log('Novo refresh_token foi salvo no banco de dados com sucesso.'); } catch (error) { console.error('Erro ao SALVAR novo refresh_token no DB:', error); } }
async function getKommoAccessToken() { const now = Date.now(); if (kommoAccessToken && now < tokenExpiresAt) { console.log('Usando Access Token do cache do Kommo.'); return kommoAccessToken; } console.log('Access Token expirado ou inexistente. Lendo refresh_token do DB...'); try { const currentRefreshToken = await getRefreshTokenFromDB(); const response = await axios.post(`${process.env.KOMMO_SUBDOMAIN}/oauth2/access_token`, { client_id: process.env.KOMMO_CLIENT_ID, client_secret: process.env.KOMMO_CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: currentRefreshToken }); kommoAccessToken = response.data.access_token; const newRefreshToken = response.data.refresh_token; tokenExpiresAt = Date.now() + (response.data.expires_in - 3600) * 1000; console.log('Novo Access Token do Kommo obtido com sucesso.'); saveRefreshTokenToDB(newRefreshToken); return kommoAccessToken; } catch (error) { console.error('Erro CRÍTICO ao buscar Access Token do Kommo:', error.response ? error.response.data : error.message); throw new Error('Falha ao autenticar com Kommo.'); } }
async function createKommoLead(dynamicPayload) { try { const accessToken = await getKommoAccessToken(); const kommoApi = axios.create({ baseURL: process.env.KOMMO_SUBDOMAIN, headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }); const response = await kommoApi.post('/api/v4/leads/complex', [dynamicPayload]); console.log('Lead complexo (dinâmico) criado no Kommo:', response.data[0].id); return response.data[0]; } catch (error) { console.error('Erro ao criar lead no Kommo (createKommoLead):', error.response ? JSON.stringify(error.response.data, null, 2) : error.message); if (error.response && error.response.status === 401) { kommoAccessToken = null; tokenExpiresAt = 0; console.log('Token do Kommo invalidado. Será renovado na próxima chamada.'); } throw error.response ? error.response.data : new Error('Erro desconhecido no Kommo'); } }
function getNestedValue(obj, path) { if (!path || !obj) return null; return path.split('.').reduce((acc, part) => acc && acc[part], obj); }

// --- ROTA DE SAÚDE ---
app.get('/', (req, res) => {
  res.send('VERSÃO 15 DA API. Whitelist do Painel Admin atualizada. 🚀');
});

// --- A "SUPER-ROTA" DE INBOUND (PÚBLICA - NÃO MUDA) ---
app.post('/inbound/:source_name', async (req, res) => { /* ...código da V11... */ 
  const { source_name } = req.params; const dadosRecebidos = req.body; let logId; let sourceId; try { const sourceResult = await pool.query('SELECT id FROM sources WHERE nome = $1', [source_name]); if (sourceResult.rows.length === 0) { console.warn(`Fonte "${source_name}" não encontrada.`); return res.status(404).send({ error: 'Fonte não encontrada.' }); } sourceId = sourceResult.rows[0].id; const logResult = await pool.query(`INSERT INTO request_logs (source_id, estado, dados_recebidos) VALUES ($1, 'pendente', $2) RETURNING id`, [sourceId, dadosRecebidos]); logId = logResult.rows[0].id; console.log(`[Log ${logId}] Recebido lead da fonte "${source_name}".`); const mappingsResult = await pool.query('SELECT campo_fonte, tipo_campo_kommo, codigo_campo_kommo FROM field_mappings WHERE source_id = $1', [sourceId]); const regras = mappingsResult.rows; if (regras.length === 0) { console.warn(`[Log ${logId}] Nenhuma regra de mapeamento encontrada...`); await pool.query("UPDATE request_logs SET estado = 'falha', resposta_kommo = $1 WHERE id = $2", [{error: "Nenhuma regra de mapeamento configurada."}, logId]); return res.status(400).send({ error: 'Nenhuma regra de mapeamento configurada.', logId: logId }); } const payloadKommo = {}; const contato = {}; const embedded = {}; const leadCustomFields = []; const contactCustomFields = []; const tags = []; for (const regra of regras) { const valor = getNestedValue(dadosRecebidos, regra.campo_fonte); if (!valor) continue; switch (regra.tipo_campo_kommo) { case 'lead_name': payloadKommo.name = valor; break; case 'contact_first_name': contato.first_name = valor; break; case 'contact_custom_field': contactCustomFields.push({ field_code: regra.codigo_campo_kommo, values: [{ value: valor }] }); break; case 'lead_custom_field': leadCustomFields.push({ field_code: regra.codigo_campo_kommo, values: [{ value: valor }] }); break; case 'tag': tags.push({ name: valor }); break; } } if (!payloadKommo.name) { payloadKommo.name = `Lead da Fonte: ${source_name}`; } if (!contato.first_name) { contato.first_name = payloadKommo.name; } embedded.contacts = [contato]; if (contactCustomFields.length > 0) { contato.custom_fields_values = contactCustomFields; } if (leadCustomFields.length > 0) { payloadKommo.custom_fields_values = leadCustomFields; } if (tags.length > 0) { embedded.tags = tags; } payloadKommo._embedded = embedded; console.log(`[Log ${logId}] Enviando payload dinâmico para o Kommo...`); const respostaKommo = await createKommoLead(payloadKommo); await pool.query("UPDATE request_logs SET estado = 'sucesso', resposta_kommo = $1 WHERE id = $2", [respostaKommo, logId]); console.log(`[Log ${logId}] Sucesso. Lead criado no Kommo: ${respostaKommo.id}`); res.status(201).send({ message: 'Lead recebido e processado com sucesso!', logId: logId }); } catch (error) { const errorDetails = error.response ? error.response.data : { message: error.message }; console.error(`[Log ${logId || 'N/A'}] Falha no processamento:`, JSON.stringify(errorDetails)); if (logId) { await pool.query("UPDATE request_logs SET estado = 'falha', resposta_kommo = $1 WHERE id = $2", [errorDetails, logId]); } res.status(500).send({ error: 'Falha ao processar o lead.', logId: logId }); }
});

// --- ROTAS DA API DE ADMIN (PROTEGIDAS - NÃO MUDAM) ---
app.get('/api/sources', checkApiKey, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM sources ORDER BY nome');
    res.status(200).json(result.rows);
  } catch (error) { console.error('Erro ao buscar sources:', error); res.status(500).send({ error: 'Erro ao buscar fontes.' }); }
});
app.get('/api/mappings/:source_id', checkApiKey, async (req, res) => {
  const { source_id } = req.params;
  try {
    const result = await pool.query('SELECT * FROM field_mappings WHERE source_id = $1', [source_id]);
    res.status(200).json(result.rows);
  } catch (error) { console.error('Erro ao buscar mappings:', error); res.status(500).send({ error: 'Erro ao buscar mapeamentos.' }); }
});
app.post('/api/sources', checkApiKey, async (req, res) => {
  const { nome, tipo = 'webhook' } = req.body; if (!nome) {return res.status(400).send({ error: 'O "nome" da fonte é obrigatório.' });} try { const result = await pool.query('INSERT INTO sources (nome, tipo) VALUES ($1, $2) RETURNING *', [nome, tipo]); res.status(201).json(result.rows[0]); } catch (error) { console.error('Erro ao criar source:', error); res.status(500).send({ error: 'Erro ao criar fonte.' }); }
});
app.post('/api/mappings', checkApiKey, async (req, res) => {
  const { source_id, mappings } = req.body; if (!source_id || !mappings || !Array.isArray(mappings)) { return res.status(400).send({ error: 'Estrutura de dados inválida.' }); } const client = await pool.connect(); try { await client.query('BEGIN'); await client.query('DELETE FROM field_mappings WHERE source_id = $1', [source_id]); for (const rule of mappings) { if (rule.campo_fonte && rule.tipo_campo_kommo && rule.codigo_campo_kommo) { await client.query(`INSERT INTO field_mappings (source_id, campo_fonte, tipo_campo_kommo, codigo_campo_kommo) VALUES ($1, $2, $3, $4)`, [source_id, rule.campo_fonte, rule.tipo_campo_kommo, rule.codigo_campo_kommo]); } } await client.query('COMMIT'); res.status(201).send({ message: 'Mapeamentos salvos com sucesso.' }); } catch (error) { await client.query('ROLLBACK'); console.error('Erro ao salvar mapeamentos:', error); res.status(500).send({ error: 'Erro ao salvar mapeamentos.' }); } finally { client.release(); }
});
// Rota para LISTAR os logs (com paginação simples)
app.get('/api/logs', checkApiKey, async (req, res) => {
  // Pega parâmetros da query string (ex: /api/logs?page=1&limit=20)
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const offset = (page - 1) * limit;
  // TODO: Adicionar filtros por source_id, estado, etc. se necessário

  try {
    // Busca os logs mais recentes primeiro, com limite e offset
    const logsResult = await pool.query(
      `SELECT l.id, l.estado, l.criado_em, s.nome as source_nome, l.dados_recebidos 
       FROM request_logs l
       LEFT JOIN sources s ON l.source_id = s.id
       ORDER BY l.criado_em DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    // Conta o total de logs (para paginação no frontend)
    const totalResult = await pool.query('SELECT COUNT(*) FROM request_logs');
    const totalLogs = parseInt(totalResult.rows[0].count);

    res.status(200).json({
      logs: logsResult.rows,
      total: totalLogs,
      page: page,
      limit: limit,
      totalPages: Math.ceil(totalLogs / limit)
    });
  } catch (error) {
    console.error('Erro ao buscar logs:', error);
    res.status(500).send({ error: 'Erro ao buscar logs.' });
  }
});
// --- ROTAS DE SETUP ANTIGAS (Manter por segurança) ---
// (Sem mudanças)
app.get('/setup-db', async (req, res) => { /* ...código antigo... */ try{await pool.query(`CREATE TABLE IF NOT EXISTS leads (id SERIAL PRIMARY KEY, nome VARCHAR(100), email VARCHAR(100), telefone VARCHAR(30), origem VARCHAR(50), dados_formulario JSONB, criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`); res.status(200).send('Tabela "leads" (antiga) verificada/criada com sucesso!');}catch(e){console.error(e);res.status(500).send('Erro');} });
app.get('/setup-config-table', async (req, res) => { /* ...código antigo... */ try{await pool.query(`CREATE TABLE IF NOT EXISTS configuracao (id SERIAL PRIMARY KEY, chave VARCHAR(100) UNIQUE NOT NULL, valor TEXT NOT NULL, atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`); res.status(200).send('Tabela "configuracao" verificada/criada com sucesso!');}catch(e){console.error(e);res.status(500).send('Erro');} });
app.post('/set-initial-token', async (req, res) => { /* ...código antigo... */ const { token } = req.body; if (!token) {return res.status(400).send('Token é obrigatório.');} try {await pool.query(`INSERT INTO configuracao (chave, valor) VALUES ('KOMMO_REFRESH_TOKEN', $1) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = CURRENT_TIMESTAMP`, [token]); res.status(200).send('Refresh Token do Kommo salvo no banco de dados com sucesso!');}catch(e){console.error(e);res.status(500).send('Erro');} });
app.get('/setup-sources-table', async (req, res) => { /* ...código antigo... */ try{await pool.query(`CREATE TABLE IF NOT EXISTS sources (id SERIAL PRIMARY KEY, nome VARCHAR(100) NOT NULL, tipo VARCHAR(50) DEFAULT 'webhook', criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`); await pool.query(`CREATE INDEX IF NOT EXISTS idx_sources_nome ON sources(nome);`); res.status(200).send('Tabela "sources" (fontes) verificada/criada com sucesso!');}catch(e){console.error(e);res.status(500).send('Erro');} });
app.get('/setup-logs-table', async (req, res) => { /* ...código antigo... */ try{await pool.query(`CREATE TABLE IF NOT EXISTS request_logs (id SERIAL PRIMARY KEY, source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL, estado VARCHAR(20) DEFAULT 'pendente', dados_recebidos JSONB, resposta_kommo JSONB, criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`); await pool.query(`CREATE INDEX IF NOT EXISTS idx_logs_source_id ON request_logs(source_id);`); await pool.query(`CREATE INDEX IF NOT EXISTS idx_logs_estado ON request_logs(estado);`); res.status(200).send('Tabela "request_logs" (registros) verificada/criada com sucesso!');}catch(e){console.error(e);res.status(500).send('Erro');} });
app.get('/setup-mappings-table', async (req, res) => { /* ...código antigo... */ try{await pool.query(`CREATE TABLE IF NOT EXISTS field_mappings (id SERIAL PRIMARY KEY, source_id INTEGER REFERENCES sources(id) ON DELETE CASCADE, campo_fonte VARCHAR(255) NOT NULL, tipo_campo_kommo VARCHAR(50) NOT NULL, codigo_campo_kommo VARCHAR(255) NOT NULL, criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`); await pool.query(`CREATE INDEX IF NOT EXISTS idx_mappings_source_id ON field_mappings(source_id);`); res.status(200).send('Tabela "field_mappings" (mapeamento) verificada/criada com sucesso!');}catch(e){console.error(e);res.status(500).send('Erro');} });
app.post('/submit-lead', async (req, res) => { res.status(410).send("Esta rota está desativada. Use /inbound/:source_name"); });

// --- Iniciar o Servidor ---
app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
});
