// --- Imports ---
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const axios = require('axios'); // NOSSA NOVA BIBLIOTECA DE API

const app = express();
const port = process.env.PORT || 8080;

// --- Configuração Essencial ---

// 1. Configura o CORS
// Por enquanto, permite qualquer origem. Mude em produção!
app.use(cors({
  origin: ['*', '*'] 
}));

// 2. Configura o Express para ler JSON
app.use(express.json());

// 3. Configuração do Banco de Dados (NÃO MUDA)
const caCert = fs.readFileSync(
  path.resolve(__dirname, 'ca-cert.crt')
).toString();

const connectionString = process.env.DATABASE_URL;
const cleanedConnectionString = connectionString.split('?')[0];

const pool = new Pool({
  connectionString: cleanedConnectionString, 
  ssl: {
    ca: caCert
  }
});

// --- LÓGICA DO KOMMO (NOVO!) ---

// Variável para guardar o token de acesso em cache (memória)
let kommoAccessToken = null;
let tokenExpiresAt = 0;

// Função para buscar/atualizar o token de acesso do Kommo
async function getKommoAccessToken() {
  const now = Date.now();

  // Se tivermos um token válido na memória, use-o
  if (kommoAccessToken && now < tokenExpiresAt) {
    console.log('Usando Access Token do cache do Kommo.');
    return kommoAccessToken;
  }

  // Se não, busque um novo token usando o REFRESH_TOKEN
  console.log('Access Token expirado ou inexistente. Buscando um novo...');
  try {
    const response = await axios.post(`${process.env.KOMMO_SUBDOMAIN}/oauth2/access_token`, {
      client_id: process.env.KOMMO_CLIENT_ID,
      client_secret: process.env.KOMMO_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: process.env.KOMMO_REFRESH_TOKEN
    });

    // Guarda o novo token e a hora que ele expira
    kommoAccessToken = response.data.access_token;
    // Salva com 1 hora (3600s) de folga para segurança
    tokenExpiresAt = Date.now() + (response.data.expires_in - 3600) * 1000; 

    console.log('Novo Access Token do Kommo obtido com sucesso.');
    return kommoAccessToken;

  } catch (error) {
    console.error('Erro ao buscar Access Token do Kommo:', error.response ? error.response.data : error.message);
    throw new Error('Falha ao autenticar com Kommo.');
  }
}

// Função para criar o lead no Kommo
async function createKommoLead(nome, email, telefone) {
  try {
    // 1. Garante que temos um token de acesso válido
    const accessToken = await getKommoAccessToken();

    // 2. Monta a chamada de API
    const kommoApi = axios.create({
      baseURL: process.env.KOMMO_SUBDOMAIN,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    // 3. Define o corpo (payload) do novo lead
    // (Isso cria um lead complexo com um contato embutido)
    const payload = [
      {
        name: `Lead de ${nome} - ${email}`, // Nome do Lead
        _embedded: {
          contacts: [
            {
              first_name: nome,
              custom_fields_values: [
                {
                  field_code: "EMAIL",
                  values: [{ value: email }]
                },
                {
                  field_code: "PHONE",
                  values: [{ value: telefone }]
                }
              ]
            }
          ]
        }
      }
    ];

    // 4. Envia o lead para o Kommo
    const response = await kommoApi.post('/api/v4/leads/complex', payload);
    console.log('Lead criado no Kommo com sucesso:', response.data[0].id);
    return response.data[0].id; // Retorna o ID do novo lead

  } catch (error) {
    console.error('Erro ao criar lead no Kommo:', error.response ? error.response.data : error.message);
    // Se o erro for de autenticação (401), limpa o token de cache para forçar a renovação na próxima vez
    if (error.response && error.response.status === 401) {
      kommoAccessToken = null;
      tokenExpiresAt = 0;
      console.log('Token do Kommo invalidado. Será renovado na próxima chamada.');
    }
  }
}

// --- Rotas da API (ATUALIZADAS) ---

// Rota de "saúde"
app.get('/', (req, res) => {
  res.send('VERSÃO 3 DA API. INTEGRANDO KOMMO. 🚀'); // Mudei a versão para V3
});

// Rota para criar a tabela (não muda)
app.get('/setup-db', async (req, res) => {
  // ... (código existente, sem mudanças) ...
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS leads (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(100),
        email VARCHAR(100),
        telefone VARCHAR(30),
        origem VARCHAR(50),
        dados_formulario JSONB,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    res.status(200).send('Tabela "leads" verificada/criada com sucesso!');
  } catch (error) {
    console.error('Erro ao criar tabela:', error);
    res.status(500).send('Erro no servidor ao criar tabela.');
  }
});

// Rota principal: Receber um novo lead (ATUALIZADA)
app.post('/submit-lead', async (req, res) => {
  
  const { nome, email, telefone, origem } = req.body;
  const dadosFormulario = req.body; 

  if (!nome || !email) {
    return res.status(400).send('Nome e Email são obrigatórios.');
  }

  console.log('Recebendo lead:', nome, email);

  try {
    // 1. Salva no Banco de Dados (PostgreSQL)
    const result = await pool.query(
      `INSERT INTO leads (nome, email, telefone, origem, dados_formulario) 
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [nome, email, telefone, origem, dadosFormulario]
    );

    const novoLeadId = result.rows[0].id;
    console.log(`Lead #${novoLeadId} salvo no banco.`);
    
    // 2. Enviar para o Kommo (NOVO!)
    // (Não precisamos esperar isso terminar para responder ao usuário)
    createKommoLead(nome, email, telefone)
      .catch(err => console.error('Falha ao enviar lead para Kommo (em background):', err.message));

    // 3. TODO: Enviar para o Notion (API)
    // (Vamos adicionar isso depois)
    console.log('TODO: Enviar para API do Notion');

    // 4. Responde para a Vercel IMEDIATAMENTE
    // (Não esperamos o Kommo terminar, para a resposta ser rápida)
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