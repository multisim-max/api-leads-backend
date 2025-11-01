// --- Imports ---
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const axios = require('axios');
const { Client } = require('@notionhq/client'); // Cliente Notion
const crypto = require('crypto-js'); // Para hashing SHA256 (Meta CAPI)

// --- NOVOS IMPORTS (Spaces e Mercado Pago) ---
const multer = require('multer');
const { S3Client } = require('@aws-sdk/client-s3');
const multerS3 = require('multer-s3-v2');
const mercadopago = require('mercadopago');

const app = express();
const port = process.env.PORT || 8080;

// --- Configuração Essencial ---
const whitelist = [
  'https://www.bairrocostaverde.com.br',
  'http://localhost:3000',
  'https://asn-asmin-widget.vercel.app',
  'https://v0-admin-page-design-dexvkykcb-multisim.vercel.app',
  // ⬇️ IMPORTANTE: Adicione a URL da sua nova Landing Page Vercel aqui ⬇️
  'https://v0-simple-event-page.vercel.app', 
  'https://acupula.vercel.app',
  'https://acupula.imobtalk.com.br'
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
app.use(express.json()); // Essencial para o Mercado Pago e Inbound

// --- Middleware de Segurança ---
const checkApiKey = (req, res, next) => {
  // ... (seu código de middleware existente)
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

// ===================================================================
// --- NOVA CONFIGURAÇÃO: DIGITALOCEAN SPACES (UPLOAD) ---
// ===================================================================
const s3Client = new S3Client({
  endpoint: `https://${process.env.DO_SPACES_ENDPOINT}`, // Ex: 'https://sfo3.digitaloceanspaces.com'
  region: process.env.DO_SPACES_REGION,               // Ex: 'sfo3'
  credentials: {
    accessKeyId: process.env.DO_SPACES_KEY,
    secretAccessKey: process.env.DO_SPACES_SECRET
  }
});

const upload = multer({
  storage: multerS3({
    s3: s3Client,
    bucket: process.env.DO_SPACES_BUCKET, // Ex: 'asndrive'
    acl: 'public-read',                   // Define o arquivo como público
    key: function (req, file, cb) {
      // Define o nome do arquivo dentro do Spaces
      // Ex: "uploads/documentos/1678886400000-meu-contrato.pdf"
      const fileName = `uploads/documentos/${Date.now()}-${file.originalname}`;
      cb(null, fileName);
    }
  })
});

// ===================================================================
// --- NOVA CONFIGURAÇÃO: MERCADO PAGO (PAGAMENTO) ---
// ===================================================================
mercadopago.configure({
  access_token: process.env.MP_ACCESS_TOKEN
});

// --- LÓGICA DO KOMMO (ROTAÇÃO DE TOKEN) ---
async function getRefreshTokenFromDB() {
  // ... (seu código existente)
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
async function saveRefreshTokenToDB(newToken) {
  // ... (seu código existente)
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
async function getKommoAccessToken() {
  // ... (seu código existente)
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
    kommoAccessToken = null;
    tokenExpiresAt = 0;
    throw new Error('Falha ao autenticar com Kommo.');
  }
}
async function createKommoLead(dynamicPayload) {
  // ... (seu código existente)
  try {
    const accessToken = await getKommoAccessToken();
    const kommoApi = axios.create({
      baseURL: process.env.KOMMO_SUBDOMAIN,
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
    });

    const response = await kommoApi.post('/api/v4/leads/complex', [dynamicPayload]);
    console.log('Lead complexo (dinâmico) criado no Kommo:', response.data[0].id);
    return response.data[0];

  } catch (error) {
    console.error('Erro ao criar lead no Kommo (createKommoLead):', error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
    if (error.response && error.response.status === 401) {
      kommoAccessToken = null;
      tokenExpiresAt = 0;
      console.log('Token do Kommo invalidado devido a erro 401. Será renovado na próxima chamada.');
    }
    throw error.response ? error.response.data : new Error('Erro desconhecido ao criar lead no Kommo');
  }
}

// --- FUNÇÃO AJUDANTE: PEGAR VALOR ANINHADO ---
function getNestedValue(obj, path) {
  // ... (seu código existente)
  if (!path || !obj) return null;
  return path.split('.').reduce((acc, part) => acc && acc[part], obj);
}

// --- LÓGICA DO NOTION ---
const notion = new Client({ auth: process.env.NOTION_API_KEY });
const notionDatabaseId = process.env.NOTION_DATABASE_ID;
async function sendLeadToNotion(leadData) {
  // ... (seu código existente)
  if (!notionDatabaseId || !process.env.NOTION_API_KEY) {
    console.error('Credenciais do Notion não configuradas nas variáveis de ambiente.');
    return;
  }
  const nome = leadData.nome || `Lead Sem Nome (${new Date().toISOString()})`;
  const email = leadData.email;
  const telefone = leadData.telefone;
  const origem = leadData.origem;
  const corretorId = leadData.corretor_id; 
  try {
    console.log(`Enviando lead ${nome} (Corretor: ${corretorId || 'N/A'}) para o Notion DB ${notionDatabaseId}...`);
    const properties = {
      'Nome': { title: [ { text: { content: nome } } ] },
      ...(email && { 'Email': { email: email } }),
      ...(telefone && { 'Telefone': { phone_number: telefone } }),
      ...(origem && { 'Origem': { rich_text: [ { text: { content: origem } } ] } }),
      ...(corretorId && { 'Corretor': { rich_text: [ { text: { content: corretorId } } ] } }),
    };
    await notion.pages.create({
      parent: { database_id: notionDatabaseId },
      properties: properties,
    });
    console.log(`Lead ${nome} (Corretor: ${corretorId || 'N/A'}) salvo no Notion com sucesso.`);
  } catch (error) {
    console.error('Erro ao enviar lead para o Notion:', error.body || error);
  }
}

// --- LÓGICA DA META CAPI ---
const META_PIXEL_ID = process.env.META_PIXEL_ID;
const META_CAPI_ACCESS_TOKEN = process.env.META_CAPI_ACCESS_TOKEN;
function sha256Hash(value) {
  // ... (seu código existente)
  if (!value) return null;
  const normalized = value.toString().toLowerCase().trim();
  return crypto.SHA256(normalized).toString(crypto.enc.Hex);
}
async function sendMetaCapiLeadEvent(leadData, clientIp, clientUserAgent) {
  // ... (seu código existente)
  if (!META_PIXEL_ID || !META_CAPI_ACCESS_TOKEN) {
    console.warn('Meta CAPI não configurada.');
    return;
  }
  const eventTime = Math.floor(Date.now() / 1000);
  const userData = {
    em: [sha256Hash(leadData.email)],
    ph: [sha256Hash(leadData.telefone)],
    fn: [sha256Hash(leadData.nome)],
    fbc: leadData.fbc || null,
    fbp: leadData.fbp || null
  };
  Object.keys(userData).forEach(key => { if (userData[key] === null || (Array.isArray(userData[key]) && userData[key][0] === null)) { delete userData[key]; } });
  const payload = {
    data: [{
      event_name: 'Lead',
      event_time: eventTime,
      event_source_url: leadData.event_source_url || null,
      action_source: 'website',
      user_data: userData,
    }],
  };
  const url = `https://graph.facebook.com/v18.0/${META_PIXEL_ID}/events?access_token=${META_CAPI_ACCESS_TOKEN}`;
  try {
    console.log(`[CAPI] Enviando evento Lead para Meta Pixel ${META_PIXEL_ID}...`);
    const response = await axios.post(url, payload, { headers: { 'Content-Type': 'application/json' } });
    console.log('[CAPI] Evento Lead enviado com sucesso para Meta:', response.data);
  } catch (error) {
    console.error('[CAPI] Erro ao enviar evento Lead para Meta:', error.response ? error.response.data : error.message);
  }
}

// --- ROTA DE SAÚDE ---
app.get('/', (req, res) => {
  res.send('API v3.0 | Módulos: Kommo, Notion, MetaCAPI, Admin, Spaces Upload, MercadoPago Checkout. 🚀');
});

// --- ROTA PÚBLICA TRACKING VIEWS ---
app.post('/api/track-view', async (req, res) => {
  // ... (seu código existente)
  const { url, corretorId } = req.body; if (!url) { return res.status(204).send(); } try { await pool.query('INSERT INTO page_views (url, corretor_id) VALUES ($1, $2)', [url, corretorId || null]); res.status(201).send({ message: 'View tracked.' }); } catch (error) { console.error('Erro ao salvar page view:', error); res.status(500).send({ error: 'Failed to track view.' }); }
});

// --- ROTA INBOUND ---
app.post('/inbound/:source_name', async (req, res) => {
  // ... (seu código existente)
  const { source_name } = req.params;
  const dadosRecebidos = req.body;
  let logId;
  let sourceId;
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress;
  const clientUserAgent = req.headers['user-agent'];
  try {
    const sourceResult = await pool.query('SELECT id FROM sources WHERE nome = $1', [source_name]); if (sourceResult.rows.length === 0) { console.warn(`Fonte "${source_name}" não encontrada.`); return res.status(404).send({ error: 'Fonte não encontrada.' }); } sourceId = sourceResult.rows[0].id; const logResult = await pool.query(`INSERT INTO request_logs (source_id, estado, dados_recebidos) VALUES ($1, 'pendente', $2) RETURNING id`, [sourceId, dadosRecebidos]); logId = logResult.rows[0].id; console.log(`[Log ${logId}] Recebido lead da fonte "${source_name}". IP: ${clientIp}`); const mappingsResult = await pool.query('SELECT campo_fonte, tipo_campo_kommo, codigo_campo_kommo FROM field_mappings WHERE source_id = $1', [sourceId]); const regras = mappingsResult.rows; if (regras.length === 0) { console.warn(`[Log ${logId}] Nenhuma regra de mapeamento encontrada...`); await pool.query("UPDATE request_logs SET estado = 'falha', resposta_kommo = $1 WHERE id = $2", [{error: "Nenhuma regra de mapeamento configurada."}, logId]); return res.status(400).send({ error: 'Nenhuma regra de mapeamento configurada.', logId: logId }); }
    const payloadKommo = {}; const contato = {}; const embedded = {}; const leadCustomFields = []; const contactCustomFields = []; const tags = [];
    for (const regra of regras) {
      const valor = getNestedValue(dadosRecebidos, regra.campo_fonte);
      if (!valor) continue;
      const isNumericId = /^\d+$/.test(regra.codigo_campo_kommo);
      const fieldIdentifier = isNumericId ? { field_id: parseInt(regra.codigo_campo_kommo) } : { field_code: regra.codigo_campo_kommo };
      switch (regra.tipo_campo_kommo) {
        case 'lead_name': payloadKommo.name = valor; break;
        case 'contact_first_name': contato.first_name = valor; break;
        case 'contact_custom_field': contactCustomFields.push({ ...fieldIdentifier, values: [{ value: valor }] }); break;
        case 'lead_custom_field': leadCustomFields.push({ ...fieldIdentifier, values: [{ value: valor }] }); break;
        case 'tag': tags.push({ name: valor }); break;
      }
    }
    if (!payloadKommo.name) { payloadKommo.name = `Lead da Fonte: ${source_name}`; } if (!contato.first_name) { contato.first_name = payloadKommo.name; } if (contactCustomFields.length > 0) { contato.custom_fields_values = contactCustomFields; } const tagWesleyExiste = tags.some(tag => tag.name === 'Wesley'); if (!tagWesleyExiste) { tags.push({ name: 'Wesley' }); } embedded.contacts = [contato]; if (leadCustomFields.length > 0) { payloadKommo.custom_fields_values = leadCustomFields; } if (tags.length > 0) { embedded.tags = tags; } if (Object.keys(embedded).length > 0) { payloadKommo._embedded = embedded; }
    console.log(`[Log ${logId}] Enviando payload para Kommo...`);
    const respostaKommo = await createKommoLead(payloadKommo);
    console.log(`[Log ${logId}] Disparando envio para Notion em background...`);
    sendLeadToNotion(dadosRecebidos).catch(err => console.error(`[Log ${logId}] Erro envio Notion:`, err));
    console.log(`[Log ${logId}] Disparando envio para Meta CAPI...`);
    sendMetaCapiLeadEvent(dadosRecebidos, clientIp, clientUserAgent).catch(err => console.error(`[Log ${logId}] Meta CAPI Send Error:`, err));
    await pool.query("UPDATE request_logs SET estado = 'sucesso', resposta_kommo = $1 WHERE id = $2", [respostaKommo, logId]);
    console.log(`[Log ${logId}] Sucesso Kommo. Lead criado: ${respostaKommo.id}`);
    res.status(201).send({ message: 'Lead recebido e processado com sucesso!', logId: logId });
  } catch (error) {
    const errorDetails = error.response ? error.response.data : { message: error.message };
    console.error(`[Log ${logId || 'N/A'}] Falha no processamento:`, JSON.stringify(errorDetails));
    if (logId) { await pool.query("UPDATE request_logs SET estado = 'falha', resposta_kommo = $1 WHERE id = $2", [errorDetails, logId]); }
    res.status(500).send({ error: 'Falha ao processar o lead.', logId: logId });
  }
});

// ===================================================================
// --- NOVAS ROTAS PÚBLICAS (UPLOAD E PAGAMENTO) ---
// ===================================================================

// --- ROTA PÚBLICA DE UPLOAD (SPACES) ---
// Esta rota é chamada pelo seu frontend Vercel para enviar arquivos
// 'meuArquivo' é o nome do campo (name) no formulário do frontend
app.post('/upload', upload.single('meuArquivo'), (req, res) => {
  if (!req.file) {
    console.warn('Tentativa de upload sem arquivo.');
    return res.status(400).send('Nenhum arquivo foi enviado.');
  }

  console.log('Arquivo salvo com sucesso no Spaces:', req.file);

  // Constrói a URL pública completa do arquivo
  const fileUrl = `https://${process.env.DO_SPACES_BUCKET}.${process.env.DO_SPACES_ENDPOINT}/${req.file.key}`;

  // Retorna a URL para o frontend
  res.status(200).json({
    message: 'Upload concluído com sucesso!',
    url: fileUrl,
    path: req.file.key // O caminho interno no bucket (ex: uploads/documentos/...)
  });

}, (error, req, res, next) => {
  // Tratamento de erro do Multer
  console.error('Erro durante o upload:', error);
  res.status(500).json({ error: `Erro no upload: ${error.message}` });
});

// --- ROTA PÚBLICA DE PAGAMENTO (MERCADO PAGO) ---
// Esta rota é chamada pelo seu frontend Vercel (Checkout Brick)
app.post('/processar-pagamento', async (req, res) => {
  // Dados enviados pelo Brick (frontend)
  const { token, amount, email, description, installments, payment_method_id } = req.body;

  if (!token || !amount || !email || !installments || !payment_method_id) {
    console.warn('Requisição de pagamento com dados incompletos.', req.body);
    return res.status(400).json({ 
      success: false, 
      message: 'Dados incompletos para o pagamento.' 
    });
  }

  const payment_data = {
    transaction_amount: Number(amount),
    token: token,
    description: description,
    installments: Number(installments),
    payment_method_id: payment_method_id,
    payer: {
      email: email
    }
    // NOTA: Para produção, adicione mais dados do 'payer' (pagador)
    // como CPF (identification) para melhorar a aprovação
  };

  try {
    // Envia o pagamento para o Mercado Pago
    console.log(`Processando pagamento de ${amount} para ${email}...`);
    const payment = await mercadopago.payment.save(payment_data);

    // Analisa a resposta
    if (payment.body.status === 'approved') {
      console.log(`Pagamento APROVADO: ID ${payment.body.id} (Status: ${payment.body.status_detail})`);
      
      // ⬇️ AQUI: Salve o ID/Status do pagamento no seu banco de dados ⬇️
      // Ex: await pool.query("UPDATE leads SET payment_status = $1 WHERE email = $2", [payment.body.status, email]);

      return res.status(201).json({
        success: true,
        message: 'Pagamento aprovado com sucesso!',
        paymentId: payment.body.id,
        status: payment.body.status
      });
    } else {
      // Pagamento recusado pelo banco ou por anti-fraude
      console.warn(`Pagamento RECUSADO: ID ${payment.body.id} (Status: ${payment.body.status}, Detalhe: ${payment.body.status_detail})`);
      return res.status(400).json({
        success: false,
        message: `Pagamento recusado: ${payment.body.status_detail}`,
        status: payment.body.status
      });
    }

  } catch (error) {
    // Erro na API (ex: chave errada, dados inválidos)
    console.error('Erro CRÍTICO ao processar pagamento:', error);
    const errorMessage = error.cause ? error.cause[0]?.description : (error.message || 'Erro desconhecido');
    return res.status(500).json({
      success: false,
      message: `Erro de integração: ${errorMessage}`
    });
  }
});


// --- ROTAS DA API DE ADMIN (PROTEGIDAS) ---
app.get('/api/sources', checkApiKey, async (req, res) => {
  // ... (seu código existente)
  try { const result = await pool.query('SELECT * FROM sources ORDER BY nome'); res.status(200).json(result.rows); } catch (error) { console.error('Erro ao buscar sources:', error); res.status(500).send({ error: 'Erro ao buscar fontes.' }); }
});
app.get('/api/mappings/:source_id', checkApiKey, async (req, res) => {
  // ... (seu código existente)
  const { source_id } = req.params; try { const result = await pool.query('SELECT * FROM field_mappings WHERE source_id = $1', [source_id]); res.status(200).json(result.rows); } catch (error) { console.error('Erro ao buscar mappings:', error); res.status(500).send({ error: 'Erro ao buscar mapeamentos.' }); }
});
app.get('/api/logs', checkApiKey, async (req, res) => {
  // ... (seu código existente)
  const page = parseInt(req.query.page) || 1; const limit = parseInt(req.query.limit) || 20; const offset = (page - 1) * limit; try { const logsResult = await pool.query(`SELECT l.id, l.estado, l.criado_em, s.nome as source_nome, l.dados_recebidos FROM request_logs l LEFT JOIN sources s ON l.source_id = s.id ORDER BY l.criado_em DESC LIMIT $1 OFFSET $2`, [limit, offset]); const totalResult = await pool.query('SELECT COUNT(*) FROM request_logs'); const totalLogs = parseInt(totalResult.rows[0].count); res.status(200).json({ logs: logsResult.rows, total: totalLogs, page: page, limit: limit, totalPages: Math.ceil(totalLogs / limit) }); } catch (error) { console.error('Erro ao buscar logs:', error); res.status(500).send({ error: 'Erro ao buscar logs.' }); }
});
app.get('/api/logs/:id', checkApiKey, async (req, res) => {
  // ... (seu código existente)
  const { id } = req.params; try { const result = await pool.query(`SELECT l.*, s.nome as source_nome FROM request_logs l LEFT JOIN sources s ON l.source_id = s.id WHERE l.id = $1`, [id]); if (result.rows.length === 0) { return res.status(404).send({ error: 'Log não encontrado.' }); } res.status(200).json(result.rows[0]); } catch (error) { console.error(`Erro ao buscar log ${id}:`, error); res.status(500).send({ error: 'Erro ao buscar detalhes do log.' }); }
});
app.get('/api/views', checkApiKey, async (req, res) => {
  // ... (seu código existente)
  try { const result = await pool.query(` SELECT COUNT(*) AS total_views, COUNT(CASE WHEN corretor_id IS NOT NULL THEN 1 END) AS views_with_corretor, COUNT(CASE WHEN corretor_id IS NULL THEN 1 END) AS views_without_corretor FROM page_views; `); res.status(200).json(result.rows[0]); } catch (error) { console.error('Erro ao buscar estatísticas de views:', error); res.status(500).send({ error: 'Erro ao buscar estatísticas.' }); }
});
app.post('/api/sources', checkApiKey, async (req, res) => {
  // ... (seu código existente)
  const { nome, tipo = 'webhook', xml_url = null } = req.body; if (!nome) {return res.status(400).send({ error: 'O "nome" da fonte é obrigatório.' });} try { const result = await pool.query('INSERT INTO sources (nome, tipo, xml_url) VALUES ($1, $2, $3) RETURNING *', [nome, tipo, xml_url]); res.status(201).json(result.rows[0]); } catch (error) { console.error('Erro ao criar source:', error); res.status(500).send({ error: 'Erro ao criar fonte.' }); }
});
app.post('/api/mappings', checkApiKey, async (req, res) => {
  // ... (seu código existente)
  const { source_id, mappings } = req.body; if (!source_id || !mappings || !Array.isArray(mappings)) { return res.status(400).send({ error: 'Estrutura de dados inválida.' }); } const client = await pool.connect(); try { await client.query('BEGIN'); await client.query('DELETE FROM field_mappings WHERE source_id = $1', [source_id]); for (const rule of mappings) { if (rule.campo_fonte && rule.tipo_campo_kommo && rule.codigo_campo_kommo) { await client.query(`INSERT INTO field_mappings (source_id, campo_fonte, tipo_campo_kommo, codigo_campo_kommo) VALUES ($1, $2, $3, $4)`, [source_id, rule.campo_fonte, rule.tipo_campo_kommo, rule.codigo_campo_kommo]); } } await client.query('COMMIT'); res.status(201).send({ message: 'Mapeamentos salvos com sucesso.' }); } catch (error) { await client.query('ROLLBACK'); console.error('Erro ao salvar mapeamentos:', error); res.status(500).send({ error: 'Erro ao salvar mapeamentos.' }); } finally { client.release(); }
});

// --- ROTAS DE SETUP ANTIGAS ---
app.get('/setup-db', async (req, res) => { /* ... seu código existente ... */ try{await pool.query(`CREATE TABLE IF NOT EXISTS leads (id SERIAL PRIMARY KEY, nome VARCHAR(100), email VARCHAR(100), telefone VARCHAR(30), origem VARCHAR(50), dados_formulario JSONB, criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`); res.status(200).send('Tabela "leads" ok.');}catch(e){console.error(e);res.status(500).send('Erro');} });
app.get('/setup-config-table', async (req, res) => { /* ... seu código existente ... */ try{await pool.query(`CREATE TABLE IF NOT EXISTS configuracao (id SERIAL PRIMARY KEY, chave VARCHAR(100) UNIQUE NOT NULL, valor TEXT NOT NULL, atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`); res.status(200).send('Tabela "configuracao" ok.');}catch(e){console.error(e);res.status(500).send('Erro');} });
app.post('/set-initial-token', async (req, res) => { /* ... seu código existente ... */ const { token } = req.body; if (!token) {return res.status(400).send('Token obrigatório.');} try {await pool.query(`INSERT INTO configuracao (chave, valor) VALUES ('KOMMO_REFRESH_TOKEN', $1) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = CURRENT_TIMESTAMP`, [token]); res.status(200).send('Token salvo no DB.');}catch(e){console.error(e);res.status(500).send('Erro');} });
app.get('/setup-sources-table', async (req, res) => { /* ... seu código existente ... */ try{await pool.query(`CREATE TABLE IF NOT EXISTS sources (id SERIAL PRIMARY KEY, nome VARCHAR(100) NOT NULL, tipo VARCHAR(50) DEFAULT 'webhook', xml_url TEXT NULL, criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`); await pool.query(`CREATE INDEX IF NOT EXISTS idx_sources_nome ON sources(nome);`); res.status(200).send('Tabela "sources" ok.');}catch(e){console.error(e);res.status(500).send('Erro');} });
app.get('/setup-logs-table', async (req, res) => { /* ... seu código existente ... */ try{await pool.query(`CREATE TABLE IF NOT EXISTS request_logs (id SERIAL PRIMARY KEY, source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL, estado VARCHAR(20) DEFAULT 'pendente', dados_recebidos JSONB, resposta_kommo JSONB, criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`); await pool.query(`CREATE INDEX IF NOT EXISTS idx_logs_source_id ON request_logs(source_id);`); await pool.query(`CREATE INDEX IF NOT EXISTS idx_logs_estado ON request_logs(estado);`); res.status(200).send('Tabela "request_logs" ok.');}catch(e){console.error(e);res.status(500).send('Erro');} });
app.get('/setup-mappings-table', async (req, res) => { /* ... seu código existente ... */ try{await pool.query(`CREATE TABLE IF NOT EXISTS field_mappings (id SERIAL PRIMARY KEY, source_id INTEGER REFERENCES sources(id) ON DELETE CASCADE, campo_fonte VARCHAR(255) NOT NULL, tipo_campo_kommo VARCHAR(50) NOT NULL, codigo_campo_kommo VARCHAR(255) NOT NULL, criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`); await pool.query(`CREATE INDEX IF NOT EXISTS idx_mappings_source_id ON field_mappings(source_id);`); res.status(200).send('Tabela "field_mappings" ok.');}catch(e){console.error(e);res.status(500).send('Erro');} });
app.get('/setup-add-xml-url-column', async (req, res) => { /* ... seu código existente ... */ try { await pool.query(`ALTER TABLE sources ADD COLUMN IF NOT EXISTS xml_url TEXT;`); res.status(200).send('Coluna "xml_url" verificada/adicionada!'); } catch (error) { console.error('Add xml_url column error:', error); res.status(500).send('Server error.'); } });
app.get('/setup-page-views-table', async (req, res) => { /* ... seu código existente ... */ try { await pool.query(`CREATE TABLE IF NOT EXISTS page_views (id SERIAL PRIMARY KEY, url TEXT, corretor_id TEXT NULL, viewed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`); await pool.query(`CREATE INDEX IF NOT EXISTS idx_page_views_url ON page_views(url);`); await pool.query(`CREATE INDEX IF NOT EXISTS idx_page_views_corretor ON page_views(corretor_id);`); await pool.query(`CREATE INDEX IF NOT EXISTS idx_page_views_time ON page_views(viewed_at);`); res.status(200).send('Tabela "page_views" verificada/criada com sucesso!'); } catch (error) { console.error('Erro ao criar tabela page_views:', error); res.status(500).send('Erro no servidor ao criar tabela.'); } });
app.post('/submit-lead', async (req, res) => { /* ... seu código existente ... */ res.status(410).send("Rota desativada. Use /inbound/:source_name"); });

// --- Iniciar o Servidor ---
app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
  console.log('--- Verificação de Variáveis de Ambiente ---');
  // Módulos Antigos
  console.log(`- KOMMO_SUBDOMAIN: ${process.env.KOMMO_SUBDOMAIN ? 'OK' : 'NÃO DEFINIDO'}`);
  console.log(`- NOTION_API_KEY: ${process.env.NOTION_API_KEY ? 'OK' : 'NÃO DEFINIDO'}`);
  console.log(`- META_PIXEL_ID: ${process.env.META_PIXEL_ID ? 'OK' : 'NÃO DEFINIDO'}`);
  console.log(`- ADMIN_API_KEY: ${process.env.ADMIN_API_KEY ? 'OK' : 'NÃO DEFINIDO'}`);
  // NOVOS: Spaces
  console.log(`- DO_SPACES_ENDPOINT: ${process.env.DO_SPACES_ENDPOINT ? 'OK' : 'NÃO DEFINIDO'}`);
  console.log(`- DO_SPACES_BUCKET: ${process.env.DO_SPACES_BUCKET ? 'OK' : 'NÃO DEFINIDO'}`);
  console.log(`- DO_SPACES_KEY: ${process.env.DO_SPACES_KEY ? 'OK (Carregada)' : 'NÃO DEFINIDO'}`);
  // NOVOS: Mercado Pago
  console.log(`- MP_ACCESS_TOKEN: ${process.env.MP_ACCESS_TOKEN ? 'OK (Carregada)' : 'NÃO DEFINIDO'}`);
  console.log('---------------------------------------------');
  console.log('API pronta para receber requisições.');
});