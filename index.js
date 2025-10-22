const fs = require('fs');
const path = require('path');

// Carrega as variáveis de ambiente (como DATABASE_URL)
require('dotenv').config();

const express = require('express');
const cors = require('cors'); // Importa o CORS
const { Pool } = require('pg'); // Importa o driver do PostgreSQL

const app = express();
const port = process.env.PORT || 8080; // A DO define a porta via process.env.PORT

// --- Configuração Essencial ---

// 1. Configura o CORS
// Isso permite que seu site na Vercel (e localhost) façam requisições para esta API.
app.use(cors({
  origin: ['*', '*'] // IMPORTANTE: Troque pelo seu domínio!
}));

// 2. Configura o Express para ler JSON
// Isso permite que a API entenda os dados JSON enviados pelo seu formulário.
app.use(express.json());

// 3. Configuração do Banco de Dados
// Carrega o certificado CA da DigitalOcean que baixamos
const caCert = fs.readFileSync(
  path.resolve(__dirname, 'ca-cert.crt')
).toString();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: true, // Agora vamos verificar (é mais seguro)
    ca: caCert                // E aqui está o certificado para confiar
  }
});

// --- Rotas da API ---

// Rota de "saúde" - para verificar se a API está no ar
app.get('/', (req, res) => {
  res.send('VERSÃO 2 DA API. TESTANDO CORREÇÃO SSL. 🚀');
});

// Rota para criar a tabela do banco de dados (só para teste inicial)
app.get('/setup-db', async (req, res) => {
  try {
    // Vamos criar uma tabela simples chamada 'leads'
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

// Rota principal: Receber um novo lead do formulário
app.post('/submit-lead', async (req, res) => {
  
  // 1. Pega os dados do corpo (body) da requisição
  // Ex: { nome: "Joao", email: "joao@teste.com", ... }
  const { nome, email, telefone, origem } = req.body;

  // Guarda todos os dados brutos em um campo JSONB para flexibilidade
  const dadosFormulario = req.body; 

  if (!nome || !email) {
    return res.status(400).send('Nome e Email são obrigatórios.');
  }

  console.log('Recebendo lead:', nome, email);

  try {
    // 2. Salva no Banco de Dados (PostgreSQL)
    const result = await pool.query(
      `INSERT INTO leads (nome, email, telefone, origem, dados_formulario) 
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [nome, email, telefone, origem, dadosFormulario]
    );

    const novoLeadId = result.rows[0].id;
    console.log(`Lead #${novoLeadId} salvo no banco.`);
    
    // 3. TODO: Enviar para o Kommo (API)
    // (Vamos adicionar isso depois)
    console.log('TODO: Enviar para API do Kommo');

    // 4. TODO: Enviar para o Notion (API)
    // (Vamos adicionar isso depois)
    console.log('TODO: Enviar para API do Notion');

    // 5. Responde para a Vercel
    res.status(201).json({ 
      message: 'Lead recebido com sucesso!', 
      leadId: novoLeadId 
    });

  } catch (error) {
    console.error('Erro ao processar lead:', error);
    res.status(500).send('Erro interno do servidor.');
  }
});

// --- Iniciar o Servidor ---
app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
});