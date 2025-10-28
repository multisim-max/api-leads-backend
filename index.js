// --- Imports ---
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const axios = require('axios');
const { Client } = require('@notionhq/client');
const crypto = require('crypto-js'); // <-- NOVO: Para hashing SHA256

const app = express();
const port = process.env.PORT || 8080;

// --- Configuração Essencial ---
const whitelist = [ /* ... sua lista ... */ 'https://www.bairrocostaverde.com.br', 'http://localhost:3000', 'https://asn-asmin-widget.vercel.app', 'https://v0-admin-page-design-dexvkykcb-multisim.vercel.app'];
const corsOptions = { /* ... */ origin: function (origin, callback) { if (whitelist.indexOf(origin) !== -1 || !origin) { callback(null, true); } else { console.warn(`CORS: ${origin} blocked.`); callback(new Error('Not allowed by CORS')); } }, methods: "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS", optionsSuccessStatus: 204 };
app.use(cors(corsOptions));
app.use(express.json());

// --- Middleware de Segurança ---
const checkApiKey = (req, res, next) => { /* ... */ const apiKey = req.headers['authorization']; const secret = process.env.ADMIN_API_KEY; if (!apiKey || apiKey !== `Bearer ${secret}`) { console.warn('Admin API Auth Failed.'); return res.status(401).send({ error: 'Unauthorized.' }); } next(); };

// --- Configuração DB ---
const caCert = fs.readFileSync(path.resolve(__dirname, 'ca-cert.crt')).toString();
const connectionString = process.env.DATABASE_URL;
const cleanedConnectionString = connectionString.split('?')[0];
const pool = new Pool({ connectionString: cleanedConnectionString, ssl: { ca: caCert } });

// --- LÓGICA DO KOMMO ---
// (Sem mudanças aqui... autenticação, createKommoLead)
let kommoAccessToken = null; let tokenExpiresAt = 0;
async function getRefreshTokenFromDB() { /* ... */ try { const result = await pool.query("SELECT valor FROM configuracao WHERE chave = 'KOMMO_REFRESH_TOKEN'"); if (result.rows.length === 0) { throw new Error('KOMMO_REFRESH_TOKEN not found.'); } return result.rows[0].valor; } catch (error) { console.error('DB Read token Error:', error); throw error; } }
async function saveRefreshTokenToDB(newToken) { /* ... */ try { await pool.query("UPDATE configuracao SET valor = $1 WHERE chave = 'KOMMO_REFRESH_TOKEN'", [newToken]); console.log('New refresh_token saved.'); } catch (error) { console.error('DB Save token Error:', error); } }
async function getKommoAccessToken() { /* ... */ const now = Date.now(); if (kommoAccessToken && now < tokenExpiresAt) { console.log('Using cached Kommo Token.'); return kommoAccessToken; } console.log('Fetching new Kommo Token...'); try { const currentRefreshToken = await getRefreshTokenFromDB(); const response = await axios.post(`${process.env.KOMMO_SUBDOMAIN}/oauth2/access_token`, { client_id: process.env.KOMMO_CLIENT_ID, client_secret: process.env.KOMMO_CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: currentRefreshToken }); kommoAccessToken = response.data.access_token; const newRefreshToken = response.data.refresh_token; tokenExpiresAt = Date.now() + (response.data.expires_in - 3600) * 1000; console.log('New Kommo Access Token obtained.'); saveRefreshTokenToDB(newRefreshToken); return kommoAccessToken; } catch (error) { console.error('Kommo Auth Error:', error.response ? error.response.data : error.message); throw new Error('Kommo Auth Failed.'); } }
async function createKommoLead(dynamicPayload) { /* ... */ try { const accessToken = await getKommoAccessToken(); const kommoApi = axios.create({ baseURL: process.env.KOMMO_SUBDOMAIN, headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }); const response = await kommoApi.post('/api/v4/leads/complex', [dynamicPayload]); console.log('Kommo Lead created:', response.data[0].id); return response.data[0]; } catch (error) { console.error('Kommo Create Lead Error:', error.response ? JSON.stringify(error.response.data, null, 2) : error.message); if (error.response && error.response.status === 401) { kommoAccessToken = null; tokenExpiresAt = 0; console.log('Kommo token invalidated.'); } throw error.response ? error.response.data : new Error('Kommo Error.'); } }
function getNestedValue(obj, path) { /* ... */ if (!path || !obj) return null; return path.split('.').reduce((acc, part) => acc && acc[part], obj); }

// --- LÓGICA NOTION ---
// (Sem mudanças aqui...)
const notion = new Client({ auth: process.env.NOTION_API_KEY }); const notionDatabaseId = process.env.NOTION_DATABASE_ID; async function sendLeadToNotion(leadData) { if (!notionDatabaseId || !process.env.NOTION_API_KEY) { console.error('Notion creds missing.'); return; } const nome = leadData.nome || `Lead Sem Nome (${new Date().toISOString()})`; const email = leadData.email; const telefone = leadData.telefone; const origem = leadData.origem; try { console.log(`Sending lead ${nome} to Notion DB ${notionDatabaseId}...`); const properties = { 'Nome': { title: [ { text: { content: nome } } ] }, ...(email && { 'Email': { email: email } }), ...(telefone && { 'Telefone': { phone_number: telefone } }), ...(origem && { 'Origem': { select: { name: origem } } }) }; await notion.pages.create({ parent: { database_id: notionDatabaseId }, properties: properties, }); console.log(`Lead ${nome} saved to Notion.`); } catch (error) { console.error('Notion Send Error:', error.body || error); } }

// --- (NOVO!) LÓGICA DA API DE CONVERSÕES DA META (CAPI) ---
const META_PIXEL_ID = process.env.META_PIXEL_ID;
const META_CAPI_ACCESS_TOKEN = process.env.META_CAPI_ACCESS_TOKEN;

// Função para hashear dados (SHA256) - Exigência da Meta
function sha256Hash(value) {
  if (!value) return null;
  // Normaliza (minúsculas, remove espaços extras) antes de hashear
  const normalized = value.toString().toLowerCase().trim();
  return crypto.SHA256(normalized).toString(crypto.enc.Hex);
}

async function sendMetaCapiLeadEvent(leadData, clientIp, clientUserAgent) {
  if (!META_PIXEL_ID || !META_CAPI_ACCESS_TOKEN) {
    console.warn('Meta CAPI não configurada (Pixel ID ou Access Token ausentes).');
    return;
  }

  const eventTime = Math.floor(Date.now() / 1000); // Timestamp Unix

  // Dados do usuário (hasheados)
  const userData = {
    em: [sha256Hash(leadData.email)],   // Email
    ph: [sha256Hash(leadData.telefone)],// Telefone (idealmente normalizado para apenas dígitos antes do hash)
    fn: [sha256Hash(leadData.nome)],    // Primeiro Nome (simplificado, podemos melhorar)
    // ln: [], // Sobrenome (não temos separado)
    // client_ip_address: clientIp, // <-- Enviado fora do userData
    // client_user_agent: clientUserAgent, // <-- Enviado fora do userData
    fbc: leadData.fbc || null, // ID de Clique (se veio do frontend)
    fbp: leadData.fbp || null  // ID de Navegador (se veio do frontend)
  };

  // Remove chaves com valores nulos/vazios do userData para limpeza
  Object.keys(userData).forEach(key => {
    if (userData[key] === null || (Array.isArray(userData[key]) && userData[key][0] === null)) {
      delete userData[key];
    }
  });

  const payload = {
    data: [
      {
        event_name: 'Lead',
        event_time: eventTime,
        event_source_url: leadData.event_source_url || null, // URL da página do lead
        action_source: 'website', // Indica que veio de um site
        user_data: userData,
        // custom_data: { // Opcional: enviar outros dados
        //   lead_source: leadData.origem
        // }
      }
    ],
    // test_event_code: 'TESTXXXXX' // <-- Use isso APENAS durante os testes no Gerenciador de Eventos
  };

  const url = `https://graph.facebook.com/v18.0/${META_PIXEL_ID}/events?access_token=${META_CAPI_ACCESS_TOKEN}`;

  try {
    console.log(`[CAPI] Enviando evento Lead para Meta Pixel ${META_PIXEL_ID}...`);
    // console.log("[CAPI] Payload:", JSON.stringify(payload, null, 2)); // Descomente para debug detalhado
    
    const response = await axios.post(url, payload, {
      headers: { 'Content-Type': 'application/json' }
    });
    
    console.log('[CAPI] Evento Lead enviado com sucesso para Meta:', response.data);

  } catch (error) {
    console.error('[CAPI] Erro ao enviar evento Lead para Meta:', error.response ? error.response.data : error.message);
  }
}

// --- ROTA DE SAÚDE ---
app.get('/', (req, res) => {
  res.send('VERSÃO 26 DA API. Adiciona Meta CAPI. 🚀');
});

// --- ROTA PÚBLICA TRACKING VIEWS ---
app.post('/api/track-view', async (req, res) => { /* ... */ const { url, corretorId } = req.body; if (!url) { return res.status(204).send(); } try { await pool.query('INSERT INTO page_views (url, corretor_id) VALUES ($1, $2)', [url, corretorId || null]); res.status(201).send({ message: 'View tracked.' }); } catch (error) { console.error('Save page view error:', error); res.status(500).send({ error: 'Failed track view.' }); } });

// --- ROTA INBOUND (ATUALIZADA) ---
app.post('/inbound/:source_name', async (req, res) => {
  const { source_name } = req.params;
  const dadosRecebidos = req.body; // <-- Agora esperamos fbc, fbp, event_source_url aqui
  let logId;
  let sourceId;

  // --- (NOVO!) Captura IP e User Agent ---
  // A DigitalOcean App Platform coloca o IP real em 'x-forwarded-for'
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress;
  const clientUserAgent = req.headers['user-agent'];
  // ------------------------------------

  try {
    // 1. Encontrar Fonte, 2. Criar Log, 3. Buscar Mapeamento
    const sourceResult = await pool.query('SELECT id FROM sources WHERE nome = $1', [source_name]); if (sourceResult.rows.length === 0) { console.warn(`Source "${source_name}" not found.`); return res.status(404).send({ error: 'Source not found.' }); } sourceId = sourceResult.rows[0].id; const logResult = await pool.query(`INSERT INTO request_logs (source_id, estado, dados_recebidos) VALUES ($1, 'pendente', $2) RETURNING id`, [sourceId, dadosRecebidos]); logId = logResult.rows[0].id; console.log(`[Log ${logId}] Received from "${source_name}". IP: ${clientIp}`); const mappingsResult = await pool.query('SELECT campo_fonte, tipo_campo_kommo, codigo_campo_kommo FROM field_mappings WHERE source_id = $1', [sourceId]); const regras = mappingsResult.rows; if (regras.length === 0) { console.warn(`[Log ${logId}] No mappings found...`); await pool.query("UPDATE request_logs SET estado = 'falha', resposta_kommo = $1 WHERE id = $2", [{error: "No mappings configured."}, logId]); return res.status(400).send({ error: 'No mappings configured.', logId: logId }); }
    
    // 4 & 5. Construir Payload Kommo
    const payloadKommo = {}; const contato = {}; const embedded = {}; const leadCustomFields = []; const contactCustomFields = []; const tags = []; for (const regra of regras) { const valor = getNestedValue(dadosRecebidos, regra.campo_fonte); if (!valor) continue; const isNumericId = /^\d+$/.test(regra.codigo_campo_kommo); const fieldIdentifier = isNumericId ? { field_id: parseInt(regra.codigo_campo_kommo) } : { field_code: regra.codigo_campo_kommo }; switch (regra.tipo_campo_kommo) { case 'lead_name': payloadKommo.name = valor; break; case 'contact_first_name': contato.first_name = valor; break; case 'contact_custom_field': contactCustomFields.push({ ...fieldIdentifier, values: [{ value: valor }] }); break; case 'lead_custom_field': leadCustomFields.push({ ...fieldIdentifier, values: [{ value: valor }] }); break; case 'tag': tags.push({ name: valor }); break; } } if (!payloadKommo.name) { payloadKommo.name = `Lead da Fonte: ${source_name}`; } if (!contato.first_name) { contato.first_name = payloadKommo.name; } if (contactCustomFields.length > 0) { contato.custom_fields_values = contactCustomFields; } const tagWesleyExiste = tags.some(tag => tag.name === 'Wesley'); if (!tagWesleyExiste) { tags.push({ name: 'Wesley' }); } embedded.contacts = [contato]; if (leadCustomFields.length > 0) { payloadKommo.custom_fields_values = leadCustomFields; } if (tags.length > 0) { embedded.tags = tags; } if (Object.keys(embedded).length > 0) { payloadKommo._embedded = embedded; }

    // 6. Enviar ao Kommo
    console.log(`[Log ${logId}] Sending payload to Kommo...`);
    const respostaKommo = await createKommoLead(payloadKommo);

    // 6.B Enviar ao Notion
    console.log(`[Log ${logId}] Triggering Notion send...`);
    sendLeadToNotion(dadosRecebidos).catch(err => console.error(`[Log ${logId}] Notion Send Error:`, err));

    // --- (NOVO!) 6.C Enviar para Meta CAPI ---
    console.log(`[Log ${logId}] Triggering Meta CAPI send...`);
    sendMetaCapiLeadEvent(dadosRecebidos, clientIp, clientUserAgent)
      .catch(err => console.error(`[Log ${logId}] Meta CAPI Send Error:`, err));

    // 7. Atualizar Log Sucesso
    await pool.query("UPDATE request_logs SET estado = 'sucesso', resposta_kommo = $1 WHERE id = $2", [respostaKommo, logId]);
    console.log(`[Log ${logId}] Kommo Success. Lead ID: ${respostaKommo.id}`);
    
    // 8. Responder ao form
    res.status(201).send({ message: 'Lead received and processed!', logId: logId });

  } catch (error) {
    // 9. Atualizar Log Falha
    const errorDetails = error.response ? error.response.data : { message: error.message };
    console.error(`[Log ${logId || 'N/A'}] Processing Failure:`, JSON.stringify(errorDetails));
    if (logId) { await pool.query("UPDATE request_logs SET estado = 'falha', resposta_kommo = $1 WHERE id = $2", [errorDetails, logId]); }
    res.status(500).send({ error: 'Failed to process lead.', logId: logId });
  }
});


// --- ROTAS ADMIN ---
// (Sem mudanças... GET/POST /api/sources, /api/mappings, /api/logs, /api/views)
app.get('/api/sources', checkApiKey, async (req, res) => { try { const result = await pool.query('SELECT * FROM sources ORDER BY nome'); res.status(200).json(result.rows); } catch (error) { console.error('Get sources error:', error); res.status(500).send({ error: 'Failed fetch sources.' }); } });
app.get('/api/mappings/:source_id', checkApiKey, async (req, res) => { const { source_id } = req.params; try { const result = await pool.query('SELECT * FROM field_mappings WHERE source_id = $1', [source_id]); res.status(200).json(result.rows); } catch (error) { console.error('Get mappings error:', error); res.status(500).send({ error: 'Failed fetch mappings.' }); } });
app.get('/api/logs', checkApiKey, async (req, res) => { const page = parseInt(req.query.page) || 1; const limit = parseInt(req.query.limit) || 20; const offset = (page - 1) * limit; try { const logsResult = await pool.query(`SELECT l.id, l.estado, l.criado_em, s.nome as source_nome, l.dados_recebidos FROM request_logs l LEFT JOIN sources s ON l.source_id = s.id ORDER BY l.criado_em DESC LIMIT $1 OFFSET $2`, [limit, offset]); const totalResult = await pool.query('SELECT COUNT(*) FROM request_logs'); const totalLogs = parseInt(totalResult.rows[0].count); res.status(200).json({ logs: logsResult.rows, total: totalLogs, page: page, limit: limit, totalPages: Math.ceil(totalLogs / limit) }); } catch (error) { console.error('Get logs error:', error); res.status(500).send({ error: 'Failed fetch logs.' }); } });
app.get('/api/logs/:id', checkApiKey, async (req, res) => { const { id } = req.params; try { const result = await pool.query(`SELECT l.*, s.nome as source_nome FROM request_logs l LEFT JOIN sources s ON l.source_id = s.id WHERE l.id = $1`, [id]); if (result.rows.length === 0) { return res.status(404).send({ error: 'Log not found.' }); } res.status(200).json(result.rows[0]); } catch (error) { console.error(`Get log ${id} error:`, error); res.status(500).send({ error: 'Failed fetch log details.' }); } });
app.get('/api/views', checkApiKey, async (req, res) => { try { const result = await pool.query(`SELECT COUNT(*) AS total_views, COUNT(CASE WHEN corretor_id IS NOT NULL THEN 1 END) AS views_with_corretor, COUNT(CASE WHEN corretor_id IS NULL THEN 1 END) AS views_without_corretor FROM page_views;`); res.status(200).json(result.rows[0]); } catch (error) { console.error('Get views error:', error); res.status(500).send({ error: 'Failed fetch stats.' }); } });
app.post('/api/sources', checkApiKey, async (req, res) => { const { nome, tipo = 'webhook', xml_url = null } = req.body; if (!nome) {return res.status(400).send({ error: 'Source name required.' });} try { const result = await pool.query('INSERT INTO sources (nome, tipo, xml_url) VALUES ($1, $2, $3) RETURNING *', [nome, tipo, xml_url]); res.status(201).json(result.rows[0]); } catch (error) { console.error('Create source error:', error); res.status(500).send({ error: 'Failed create source.' }); } });
app.post('/api/mappings', checkApiKey, async (req, res) => { const { source_id, mappings } = req.body; if (!source_id || !mappings || !Array.isArray(mappings)) { return res.status(400).send({ error: 'Invalid data.' }); } const client = await pool.connect(); try { await client.query('BEGIN'); await client.query('DELETE FROM field_mappings WHERE source_id = $1', [source_id]); for (const rule of mappings) { if (rule.campo_fonte && rule.tipo_campo_kommo && rule.codigo_campo_kommo) { await client.query(`INSERT INTO field_mappings (source_id, campo_fonte, tipo_campo_kommo, codigo_campo_kommo) VALUES ($1, $2, $3, $4)`, [source_id, rule.campo_fonte, rule.tipo_campo_kommo, rule.codigo_campo_kommo]); } } await client.query('COMMIT'); res.status(201).send({ message: 'Mappings saved.' }); } catch (error) { await client.query('ROLLBACK'); console.error('Save mappings error:', error); res.status(500).send({ error: 'Failed save mappings.' }); } finally { client.release(); } });

// --- ROTAS SETUP ---
// (Sem mudanças)
app.get('/setup-db', async (req, res) => { /* ... */ try{await pool.query(`CREATE TABLE IF NOT EXISTS leads (id SERIAL PRIMARY KEY, nome VARCHAR(100), email VARCHAR(100), telefone VARCHAR(30), origem VARCHAR(50), dados_formulario JSONB, criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`); res.status(200).send('Table "leads" ok.');}catch(e){console.error(e);res.status(500).send('Error');} });
app.get('/setup-config-table', async (req, res) => { /* ... */ try{await pool.query(`CREATE TABLE IF NOT EXISTS configuracao (id SERIAL PRIMARY KEY, chave VARCHAR(100) UNIQUE NOT NULL, valor TEXT NOT NULL, atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`); res.status(200).send('Table "configuracao" ok.');}catch(e){console.error(e);res.status(500).send('Error');} });
app.post('/set-initial-token', async (req, res) => { /* ... */ const { token } = req.body; if (!token) {return res.status(400).send('Token required.');} try {await pool.query(`INSERT INTO configuracao (chave, valor) VALUES ('KOMMO_REFRESH_TOKEN', $1) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = CURRENT_TIMESTAMP`, [token]); res.status(200).send('Token saved.');}catch(e){console.error(e);res.status(500).send('Error');} });
app.get('/setup-sources-table', async (req, res) => { /* ... */ try{await pool.query(`CREATE TABLE IF NOT EXISTS sources (id SERIAL PRIMARY KEY, nome VARCHAR(100) NOT NULL, tipo VARCHAR(50) DEFAULT 'webhook', criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`); await pool.query(`CREATE INDEX IF NOT EXISTS idx_sources_nome ON sources(nome);`); res.status(200).send('Table "sources" ok.');}catch(e){console.error(e);res.status(500).send('Error');} });
app.get('/setup-logs-table', async (req, res) => { /* ... */ try{await pool.query(`CREATE TABLE IF NOT EXISTS request_logs (id SERIAL PRIMARY KEY, source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL, estado VARCHAR(20) DEFAULT 'pendente', dados_recebidos JSONB, resposta_kommo JSONB, criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`); await pool.query(`CREATE INDEX IF NOT EXISTS idx_logs_source_id ON request_logs(source_id);`); await pool.query(`CREATE INDEX IF NOT EXISTS idx_logs_estado ON request_logs(estado);`); res.status(200).send('Table "request_logs" ok.');}catch(e){console.error(e);res.status(500).send('Error');} });
app.get('/setup-mappings-table', async (req, res) => { /* ... */ try{await pool.query(`CREATE TABLE IF NOT EXISTS field_mappings (id SERIAL PRIMARY KEY, source_id INTEGER REFERENCES sources(id) ON DELETE CASCADE, campo_fonte VARCHAR(255) NOT NULL, tipo_campo_kommo VARCHAR(50) NOT NULL, codigo_campo_kommo VARCHAR(255) NOT NULL, criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`); await pool.query(`CREATE INDEX IF NOT EXISTS idx_mappings_source_id ON field_mappings(source_id);`); res.status(200).send('Table "field_mappings" ok.');}catch(e){console.error(e);res.status(500).send('Error');} });
app.get('/setup-add-xml-url-column', async (req, res) => { /* ... */ try { await pool.query(`ALTER TABLE sources ADD COLUMN IF NOT EXISTS xml_url TEXT;`); res.status(200).send('Column "xml_url" checked/added.'); } catch (error) { console.error('Add xml_url column error:', error); res.status(500).send('Server error.'); } });
app.get('/setup-page-views-table', async (req, res) => { /* ... */ try { await pool.query(`CREATE TABLE IF NOT EXISTS page_views (id SERIAL PRIMARY KEY, url TEXT, corretor_id TEXT NULL, viewed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`); await pool.query(`CREATE INDEX IF NOT EXISTS idx_page_views_url ON page_views(url);`); await pool.query(`CREATE INDEX IF NOT EXISTS idx_page_views_corretor ON page_views(corretor_id);`); await pool.query(`CREATE INDEX IF NOT EXISTS idx_page_views_time ON page_views(viewed_at);`); res.status(200).send('Table "page_views" ok.'); } catch (error) { console.error('Create page_views error:', error); res.status(500).send('Server error.'); } });
app.post('/submit-lead', async (req, res) => { res.status(410).send("Route disabled. Use /inbound/:source_name"); });

// --- Iniciar Servidor ---
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});