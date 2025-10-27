// --- Imports ---
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const axios = require('axios');
const { Client } = require('@notionhq/client'); // Cliente Notion

const app = express();
const port = process.env.PORT || 8080;

// --- Configuração Essencial ---
const whitelist = [
  'https://www.bairrocostaverde.com.br',
  'http://localhost:3000',
  'https://asn-asmin-widget.vercel.app',
  'https://v0-admin-page-design-dexvkykcb-multisim.vercel.app'
];
const corsOptions = {
  origin: function (origin, callback) {
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

// --- Middleware de Segurança ---
const checkApiKey = (req, res, next) => {
  const apiKey = req.headers['authorization'];
  const secret = process.env.ADMIN_API_KEY;
  if (!apiKey || apiKey !== `Bearer ${secret}`) {
    console.warn('Tentativa de acesso não autorizado à API de Admin.');
    return res.status(401).send({ error: 'Não autorizado.' });
  }
  next();
};

// --- Configuração do Banco de Dados ---
const caCert = fs.readFileSync(path.resolve(__dirname, 'ca-cert.crt')).toString();
const connectionString = process.env.DATABASE_URL;
const cleanedConnectionString = connectionString.split('?')[0];
const pool = new Pool({ connectionString: cleanedConnectionString, ssl: { ca: caCert } });

// --- LÓGICA DO KOMMO (ROTAÇÃO DE TOKEN - NÃO MUDA) ---
let kommoAccessToken = null; let tokenExpiresAt = 0;
async function getRefreshTokenFromDB() { try { const result = await pool.query("SELECT valor FROM configuracao WHERE chave = 'KOMMO_REFRESH_TOKEN'"); if (result.rows.length === 0) { throw new Error('KOMMO_REFRESH_TOKEN não encontrado.'); } return result.rows[0].valor; } catch (error) { console.error('Erro LER token DB:', error); throw error; } }
async function saveRefreshTokenToDB(newToken) { try { await pool.query("UPDATE configuracao SET valor = $1 WHERE chave = 'KOMMO_REFRESH_TOKEN'", [newToken]); console.log('Novo refresh_token salvo no DB.'); } catch (error) { console.error('Erro SALVAR token DB:', error); } }
async function getKommoAccessToken() { const now = Date.now(); if (kommoAccessToken && now < tokenExpiresAt) { console.log('Usando Access Token Kommo cache.'); return kommoAccessToken; } console.log('Lendo refresh_token do DB...'); try { const currentRefreshToken = await getRefreshTokenFromDB(); const response = await axios.post(`${process.env.KOMMO_SUBDOMAIN}/oauth2/access_token`, { client_id: process.env.KOMMO_CLIENT_ID, client_secret: process.env.KOMMO_CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: currentRefreshToken }); kommoAccessToken = response.data.access_token; const newRefreshToken = response.data.refresh_token; tokenExpiresAt = Date.now() + (response.data.expires_in - 3600) * 1000; console.log('Novo Access Token Kommo obtido.'); saveRefreshTokenToDB(newRefreshToken); return kommoAccessToken; } catch (error) { console.error('Erro CRÍTICO Kommo Auth:', error.response ? error.response.data : error.message); throw new Error('Falha autenticar Kommo.'); } }
async function createKommoLead(dynamicPayload) { try { const accessToken = await getKommoAccessToken(); const kommoApi = axios.create({ baseURL: process.env.KOMMO_SUBDOMAIN, headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }); const response = await kommoApi.post('/api/v4/leads/complex', [dynamicPayload]); console.log('Lead Kommo criado:', response.data[0].id); return response.data[0]; } catch (error) { console.error('Erro criar lead Kommo:', error.response ? JSON.stringify(error.response.data, null, 2) : error.message); if (error.response && error.response.status === 401) { kommoAccessToken = null; tokenExpiresAt = 0; console.log('Token Kommo invalidado.'); } throw error.response ? error.response.data : new Error('Erro Kommo.'); } }
function getNestedValue(obj, path) { if (!path || !obj) return null; return path.split('.').reduce((acc, part) => acc && acc[part], obj); }

// --- LÓGICA DO NOTION ---
const notion = new Client({ auth: process.env.NOTION_API_KEY });
const notionDatabaseId = process.env.NOTION_DATABASE_ID;
async function sendLeadToNotion(leadData) { if (!notionDatabaseId || !process.env.NOTION_API_KEY) { console.error('Credenciais Notion não configuradas.'); return; } const nome = leadData.nome || `Lead Sem Nome (${new Date().toISOString()})`; const email = leadData.email; const telefone = leadData.telefone; const origem = leadData.origem; try { console.log(`Enviando lead ${nome} para Notion DB ${notionDatabaseId}...`); const properties = { 'Nome': { title: [ { text: { content: nome } } ] }, ...(email && { 'Email': { email: email } }), ...(telefone && { 'Telefone': { phone_number: telefone } }), ...(origem && { 'Origem': { select: { name: origem } } })}; await notion.pages.create({ parent: { database_id: notionDatabaseId }, properties: properties, }); console.log(`Lead ${nome} salvo no Notion.`); } catch (error) { console.error('Erro enviar lead Notion:', error.body || error); } }

// --- ROTA DE SAÚDE ---
app.get('/', (req, res) => {
  res.send('VERSÃO 23 DA API. Aceita xml_url. 🚀');
});

// --- A "SUPER-ROTA" DE INBOUND (PÚBLICA - NÃO MUDA) ---
app.post('/inbound/:source_name', async (req, res) => { /* ...código da V19... */ 
  const { source_name } = req.params; const dadosRecebidos = req.body; let logId; let sourceId; try { const sourceResult = await pool.query('SELECT id FROM sources WHERE nome = $1', [source_name]); if (sourceResult.rows.length === 0) { console.warn(`Fonte "${source_name}" não encontrada.`); return res.status(404).send({ error: 'Fonte não encontrada.' }); } sourceId = sourceResult.rows[0].id; const logResult = await pool.query(`INSERT INTO request_logs (source_id, estado, dados_recebidos) VALUES ($1, 'pendente', $2) RETURNING id`, [sourceId, dadosRecebidos]); logId = logResult.rows[0].id; console.log(`[Log ${logId}] Recebido lead da fonte "${source_name}".`); const mappingsResult = await pool.query('SELECT campo_fonte, tipo_campo_kommo, codigo_campo_kommo FROM field_mappings WHERE source_id = $1', [sourceId]); const regras = mappingsResult.rows; if (regras.length === 0) { console.warn(`[Log ${logId}] Nenhuma regra de mapeamento encontrada...`); await pool.query("UPDATE request_logs SET estado = 'falha', resposta_kommo = $1 WHERE id = $2", [{error: "Nenhuma regra configurada."}, logId]); return res.status(400).send({ error: 'Nenhuma regra configurada.', logId: logId }); } const payloadKommo = {}; const contato = {}; const embedded = {}; const leadCustomFields = []; const contactCustomFields = []; const tags = []; for (const regra of regras) { const valor = getNestedValue(dadosRecebidos, regra.campo_fonte); if (!valor) continue; switch (regra.tipo_campo_kommo) { case 'lead_name': payloadKommo.name = valor; break; case 'contact_first_name': contato.first_name = valor; break; case 'contact_custom_field': contactCustomFields.push({ field_code: regra.codigo_campo_kommo, values: [{ value: valor }] }); break; case 'lead_custom_field': leadCustomFields.push({ field_code: regra.codigo_campo_kommo, values: [{ value: valor }] }); break; case 'tag': tags.push({ name: valor }); break; } } if (!payloadKommo.name) { payloadKommo.name = `Lead da Fonte: ${source_name}`; } if (!contato.first_name) { contato.first_name = payloadKommo.name; } if (contactCustomFields.length > 0) { contato.custom_fields_values = contactCustomFields; } const tagWesleyExiste = tags.some(tag => tag.name === 'Wesley'); if (!tagWesleyExiste) { tags.push({ name: 'Wesley' }); } embedded.contacts = [contato]; if (leadCustomFields.length > 0) { payloadKommo.custom_fields_values = leadCustomFields; } if (tags.length > 0) { embedded.tags = tags; } if (Object.keys(embedded).length > 0) { payloadKommo._embedded = embedded; } console.log(`[Log ${logId}] Enviando payload para Kommo...`); const respostaKommo = await createKommoLead(payloadKommo); console.log(`[Log ${logId}] Disparando envio para Notion em background...`); sendLeadToNotion(dadosRecebidos).catch(err => console.error(`[Log ${logId}] Erro envio Notion:`, err)); await pool.query("UPDATE request_logs SET estado = 'sucesso', resposta_kommo = $1 WHERE id = $2", [respostaKommo, logId]); console.log(`[Log ${logId}] Sucesso Kommo. Lead criado: ${respostaKommo.id}`); res.status(201).send({ message: 'Lead recebido e processado com sucesso!', logId: logId }); } catch (error) { const errorDetails = error.response ? error.response.data : { message: error.message }; console.error(`[Log ${logId || 'N/A'}] Falha no processamento:`, JSON.stringify(errorDetails)); if (logId) { await pool.query("UPDATE request_logs SET estado = 'falha', resposta_kommo = $1 WHERE id = $2", [errorDetails, logId]); } res.status(500).send({ error: 'Falha ao processar o lead.', logId: logId }); }
});

// --- ROTAS DA API DE ADMIN (PROTEGIDAS) ---

app.get('/api/sources', checkApiKey, async (req, res) => { try { const result = await pool.query('SELECT * FROM sources ORDER BY nome'); res.status(200).json(result.rows); } catch (error) { console.error('Erro buscar sources:', error); res.status(500).send({ error: 'Erro buscar fontes.' }); } });
app.get('/api/mappings/:source_id', checkApiKey, async (req, res) => { const { source_id } = req.params; try { const result = await pool.query('SELECT * FROM field_mappings WHERE source_id = $1', [source_id]); res.status(200).json(result.rows); } catch (error) { console.error('Erro buscar mappings:', error); res.status(500).send({ error: 'Erro buscar mapeamentos.' }); } });
app.get('/api/logs', checkApiKey, async (req, res) => { const page = parseInt(req.query.page) || 1; const limit = parseInt(req.query.limit) || 20; const offset = (page - 1) * limit; try { const logsResult = await pool.query(`SELECT l.id, l.estado, l.criado_em, s.nome as source_nome, l.dados_recebidos FROM request_logs l LEFT JOIN sources s ON l.source_id = s.id ORDER BY l.criado_em DESC LIMIT $1 OFFSET $2`, [limit, offset]); const totalResult = await pool.query('SELECT COUNT(*) FROM request_logs'); const totalLogs = parseInt(totalResult.rows[0].count); res.status(200).json({ logs: logsResult.rows, total: totalLogs, page: page, limit: limit, totalPages: Math.ceil(totalLogs / limit) }); } catch (error) { console.error('Erro buscar logs:', error); res.status(500).send({ error: 'Erro buscar logs.' }); } });
app.get('/api/logs/:id', checkApiKey, async (req, res) => { const { id } = req.params; try { const result = await pool.query(`SELECT l.*, s.nome as source_nome FROM request_logs l LEFT JOIN sources s ON l.source_id = s.id WHERE l.id = $1`, [id]); if (result.rows.length === 0) { return res.status(404).send({ error: 'Log não encontrado.' }); } res.status(200).json(result.rows[0]); } catch (error) { console.error(`Erro buscar log ${id}:`, error); res.status(500).send({ error: 'Erro buscar detalhes.' }); } });

// Rota para CRIAR uma nova fonte (ATUALIZADA para aceitar xml_url)
app.post('/api/sources', checkApiKey, async (req, res) => {
  const { nome, tipo = 'webhook', xml_url = null } = req.body; 
  if (!nome) {
    return res.status(400).send({ error: 'O "nome" da fonte é obrigatório.' });
  }
  try {
    const result = await pool.query(
      'INSERT INTO sources (nome, tipo, xml_url) VALUES ($1, $2, $3) RETURNING *',
      [nome, tipo, xml_url] 
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao criar source:', error);
    res.status(500).send({ error: 'Erro ao criar fonte.' });
  }
});

app.post('/api/mappings', checkApiKey, async (req, res) => { const { source_id, mappings } = req.body; if (!source_id || !mappings || !Array.isArray(mappings)) { return res.status(400).send({ error: 'Dados inválidos.' }); } const client = await pool.connect(); try { await client.query('BEGIN'); await client.query('DELETE FROM field_mappings WHERE source_id = $1', [source_id]); for (const rule of mappings) { if (rule.campo_fonte && rule.tipo_campo_kommo && rule.codigo_campo_kommo) { await client.query(`INSERT INTO field_mappings (source_id, campo_fonte, tipo_campo_kommo, codigo_campo_kommo) VALUES ($1, $2, $3, $4)`, [source_id, rule.campo_fonte, rule.tipo_campo_kommo, rule.codigo_campo_kommo]); } } await client.query('COMMIT'); res.status(201).send({ message: 'Mapeamentos salvos.' }); } catch (error) { await client.query('ROLLBACK'); console.error('Erro salvar mapeamentos:', error); res.status(500).send({ error: 'Erro salvar mapeamentos.' }); } finally { client.release(); } });

// --- ROTAS DE SETUP ANTIGAS ---
// (Sem mudanças)
app.get('/setup-db', async (req, res) => { /* ... */ try{await pool.query(`CREATE TABLE IF NOT EXISTS leads (id SERIAL PRIMARY KEY, nome VARCHAR(100), email VARCHAR(100), telefone VARCHAR(30), origem VARCHAR(50), dados_formulario JSONB, criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`); res.status(200).send('Tabela "leads" ok.');}catch(e){console.error(e);res.status(500).send('Erro');} });
app.get('/setup-config-table', async (req, res) => { /* ... */ try{await pool.query(`CREATE TABLE IF NOT EXISTS configuracao (id SERIAL PRIMARY KEY, chave VARCHAR(100) UNIQUE NOT NULL, valor TEXT NOT NULL, atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`); res.status(200).send('Tabela "configuracao" ok.');}catch(e){console.error(e);res.status(500).send('Erro');} });
app.post('/set-initial-token', async (req, res) => { /* ... */ const { token } = req.body; if (!token) {return res.status(400).send('Token obrigatório.');} try {await pool.query(`INSERT INTO configuracao (chave, valor) VALUES ('KOMMO_REFRESH_TOKEN', $1) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = CURRENT_TIMESTAMP`, [token]); res.status(200).send('Token salvo no DB.');}catch(e){console.error(e);res.status(500).send('Erro');} });
app.get('/setup-sources-table', async (req, res) => { /* ... */ try{await pool.query(`CREATE TABLE IF NOT EXISTS sources (id SERIAL PRIMARY KEY, nome VARCHAR(100) NOT NULL, tipo VARCHAR(50) DEFAULT 'webhook', criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`); await pool.query(`CREATE INDEX IF NOT EXISTS idx_sources_nome ON sources(nome);`); res.status(200).send('Tabela "sources" ok.');}catch(e){console.error(e);res.status(500).send('Erro');} });
app.get('/setup-logs-table', async (req, res) => { /* ... */ try{await pool.query(`CREATE TABLE IF NOT EXISTS request_logs (id SERIAL PRIMARY KEY, source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL, estado VARCHAR(20) DEFAULT 'pendente', dados_recebidos JSONB, resposta_kommo JSONB, criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`); await pool.query(`CREATE INDEX IF NOT EXISTS idx_logs_source_id ON request_logs(source_id);`); await pool.query(`CREATE INDEX IF NOT EXISTS idx_logs_estado ON request_logs(estado);`); res.status(200).send('Tabela "request_logs" ok.');}catch(e){console.error(e);res.status(500).send('Erro');} });
app.get('/setup-mappings-table', async (req, res) => { /* ... */ try{await pool.query(`CREATE TABLE IF NOT EXISTS field_mappings (id SERIAL PRIMARY KEY, source_id INTEGER REFERENCES sources(id) ON DELETE CASCADE, campo_fonte VARCHAR(255) NOT NULL, tipo_campo_kommo VARCHAR(50) NOT NULL, codigo_campo_kommo VARCHAR(255) NOT NULL, criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`); await pool.query(`CREATE INDEX IF NOT EXISTS idx_mappings_source_id ON field_mappings(source_id);`); res.status(200).send('Tabela "field_mappings" ok.');}catch(e){console.error(e);res.status(500).send('Erro');} });
// Rota SETUP para adicionar coluna xml_url (V22)
app.get('/setup-add-xml-url-column', async (req, res) => { try { await pool.query(`ALTER TABLE sources ADD COLUMN IF NOT EXISTS xml_url TEXT;`); res.status(200).send('Coluna "xml_url" verificada/adicionada à tabela "sources"!'); } catch (error) { console.error('Erro ao adicionar coluna xml_url:', error); res.status(500).send('Erro no servidor ao alterar tabela.'); } });
// Rota antiga desativada
app.post('/submit-lead', async (req, res) => { res.status(410).send("Rota desativada. Use /inbound/:source_name"); });

// --- Iniciar o Servidor ---
app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
});