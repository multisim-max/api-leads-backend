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

// --- LÓGICA DO KOMMO ---

// (A função getKommoAccessToken não muda em nada)
let kommoAccessToken = null;
let tokenExpiresAt = 0;
async function getKommoAccessToken() {
  const now = Date.now();
  if (kommoAccessToken && now < tokenExpiresAt) {
    console.log('Usando Access Token do cache do Kommo.');
    return kommoAccessToken;
  }
  console.log('Access Token expirado ou inexistente. Buscando um novo...');
  try {
    const response = await axios.post(`${process.env.KOMMO_SUBDOMAIN}/oauth2/access_token`, {
      client_id: process.env.KOMMO_CLIENT_ID,
      client_secret: process.env.KOMMO_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: process.env.KOMMO_REFRESH_TOKEN
    });
    kommoAccessToken = response.data.access_token;
    tokenExpiresAt = Date.now() + (response.data.expires_in - 3600) * 1000; 
    console.log('Novo Access Token do Kommo obtido com sucesso.');
    return kommoAccessToken;
  } catch (error) {
    console.error('Erro ao buscar Access Token do Kommo:', error.response ? error.response.data : error.message);
    throw new Error('Falha ao autenticar com Kommo.');
  }
}

// --- MUDANÇA AQUI (1/2) ---
// A função agora recebe o objeto 'leadData' inteiro, não só os 3 campos
async function createKommoLead(leadData) {
  // Destruturamos os dados que vêm do formulário
  const { nome, email, telefone, origem } = leadData;

  try {
    const accessToken = await getKommoAccessToken();
    const kommoApi = axios.create({
      baseURL: process.env.KOMMO_SUBDOMAIN,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    // --- (NOVO!) Mapeamento de Tags ---
    const tagsParaAdicionar = [];
    if (origem) {
      // Adiciona a 'origem' (ex: "Teste Final Postman") como uma Tag
      tagsParaAdicionar.push({ name: origem });
    }
    // Você pode adicionar mais tags estáticas se quiser, por exemplo:
    // tagsParaAdicionar.push({ name: "API DigitalOcean" });

    // 4. Define o corpo (payload) do novo lead
    const payload = [
      {
        name: `Lead de ${nome} - ${email}`, // Nome do Lead
        _embedded: {
          // (NOVO!) Adiciona o array de tags
          // (Só adiciona a chave 'tags' se o array não estiver vazio)
          ...(tagsParaAdicionar.length > 0 && { tags: tagsParaAdicionar }),

          // (EXISTENTE) Mantém os contatos
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

    // 5. Envia o lead para o Kommo
    const response = await kommoApi.post('/api/v4/leads/complex', payload);
    console.log('Lead complexo (com tags) criado no Kommo:', response.data[0].id);
    return response.data[0].id;

  } catch (error) {
    console.error('Erro ao criar lead no Kommo:', error.response ? error.response.data : error.message);
    if (error.response && error.response.status === 401) {
      kommoAccessToken = null;
      tokenExpiresAt = 0;
      console.log('Token do Kommo invalidado. Será renovado na próxima chamada.');
    }
  }
}

// --- Rotas da API ---

// Rota de "saúde"
app.get('/', (req, res) => {
  // Vamos atualizar a versão para sabermos que o deploy funcionou
  res.send('VERSÃO 4 DA API. Mapeando Tags. 🚀');
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
  } catch (error) {
    console.error('Erro ao criar tabela:', error);
    res.status(500).send('Erro no servidor ao criar tabela.');
  }
});

// Rota principal: Receber um novo lead
app.post('/submit-lead', async (req, res) => {
  
  const { nome, email, telefone, origem } = req.body;

  if (!nome || !email) {
    return res.status(400).send('Nome e Email são obrigatórios.');
  }

  console.log('Recebendo lead:', nome, email);

  try {
    // 1. Salva no Banco de Dados (PostgreSQL)
    // Agora salvamos o req.body inteiro no campo 'dados_formulario'
    const result = await pool.query(
      `INSERT INTO leads (nome, email, telefone, origem, dados_formulario) 
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [nome, email, telefone, origem, req.body] // Salva o body inteiro
    );

    const novoLeadId = result.rows[0].id;
    console.log(`Lead #${novoLeadId} salvo no banco.`);
    
    // --- MUDANÇA AQUI (2/2) ---
    // Agora passamos o 'req.body' inteiro para a função do Kommo
    createKommoLead(req.body)
      .catch(err => console.error('Falha ao enviar lead para Kommo (em background):', err.message));

    // 3. TODO: Enviar para API do Notion
    console.log('TODO: Enviar para API do Notion');

    // 4. Responde para a Vercel IMEDIATAMENTE
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