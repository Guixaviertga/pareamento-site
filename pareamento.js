'use strict'
// Site simples pra gerar o código de pareamento do WhatsApp, pra quando
// não dá pra usar o terminal interativo (celular, painel de hospedagem sem
// console, etc). Ele só CRIA a sessão; quem usa a sessão depois é o bot.
//
// Usa só o módulo "http" do Node de propósito, sem express: quanto menos
// dependência, menos chance de quebrar a instalação (Termux/hospedagem
// compartilhada costumam falhar em pacote que precisa compilar).
//
// 🔒 SEGURANÇA — leia antes de expor isso na internet:
// Quem abre essa página consegue parear um número na sessão gerada. Se
// ficar aberto num IP público sem proteção, qualquer um que achar a porta
// pode parear o PRÓPRIO número. Por isso:
//   - sem senha definida, o servidor escuta SÓ em 127.0.0.1 (localhost),
//     que é inacessível de fora da máquina;
//   - pra abrir pra internet, defina PAREAMENTO_TOKEN e acesse com
//     ?token=SUA_SENHA na URL.
//
// Uso:
//   node pareamento.js                         -> http://localhost:3000 (só local)
//   PAREAMENTO_TOKEN=algo node pareamento.js   -> aberto, exigindo o token
//   PASTA_SESSAO=/caminho/do/bot/database/baileys node pareamento.js
//                                              -> grava direto na pasta do bot
//   GITHUB_TOKEN=ghp_xxx node pareamento.js    -> session id CURTO via Gist
//                                              (sem isso, sai o id longo)
const http = require('http')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const pino = require('pino')
const {
  default: makeWASocket,
  useMultiFileAuthState,
  jidNormalizedUser,
  fetchLatestBaileysVersion,
  Browsers,
  delay,
  DisconnectReason,
} = require('@innovatorssoft/baileys')
const { gerarWelcomeCard, gerarGfx, gerarFramesFigurinha } = require('./imagens')

// dotenv é opcional aqui: se existir um .env do lado, ele é lido; se o
// pacote não estiver instalado, segue normal só com as variáveis de
// ambiente (esse projeto roda sozinho, não depende de config de bot).
try {
  require('dotenv').config({ path: path.join(__dirname, '.env') })
} catch (e) { /* sem dotenv, usa só o ambiente */ }

// config.js é opcional: quem preferir editar um arquivo em vez de mexer
// com variável de ambiente/.env preenche ele. Uma variável de ambiente com
// o mesmo nome, se definida, tem prioridade sobre o que estiver aqui.
let config = {}
try {
  config = require('./config.js') || {}
} catch (e) { /* sem config.js, usa só o ambiente */ }

// Onde a sessão é gravada. Rodando na MESMA máquina do bot, dá pra apontar
// direto pra pasta dele (PASTA_SESSAO) e não precisa copiar nada depois.
const PASTA_SESSAO = process.env.PASTA_SESSAO || config.PASTA_SESSAO || ''
const AUTH_DIR = PASTA_SESSAO
  ? path.resolve(PASTA_SESSAO)
  : path.join(__dirname, 'sessao', 'baileys')
const PORTA = Number(process.env.PAREAMENTO_PORTA || process.env.PORT || config.PAREAMENTO_PORTA || 3000)
const TOKEN = String(process.env.PAREAMENTO_TOKEN || config.PAREAMENTO_TOKEN || '').trim()
const GITHUB_TOKEN = String(process.env.GITHUB_TOKEN || config.GITHUB_TOKEN || '').trim()
// Sem senha => só localhost. Com senha => aceita de fora.
const HOST = TOKEN ? '0.0.0.0' : '127.0.0.1'

// Prefixo do session id — o MESMO formato usado no site do inrl e no
// XAVIER-MD (arquivos/core/sessionBackup.js), de propósito: um session id
// gerado num lugar funciona em qualquer um dos outros.
const PREFIXO_SESSION = 'XAVIER'

// Versão do WhatsApp Web usada como RESERVA se a busca de rede
// (fetchLatestBaileysVersion) falhar. 🐛 Bug real confirmado ao vivo: sem
// uma versão recente, o socket emite o código mas fica preso em
// "connecting" pra sempre e o WhatsApp recusa o registro ("não foi
// possível conectar o dispositivo"). Atualize esse número se um dia parar
// de novo (rode: node -e "require('@innovatorssoft/baileys').fetchLatestBaileysVersion().then(r=>console.log(r.version))").
const VERSAO_RESERVA = [2, 3000, 1045297628]

async function versaoWhatsApp() {
  try {
    const { version } = await fetchLatestBaileysVersion()
    return version
  } catch (e) {
    console.log('[PAREAMENTO] não consegui buscar a versão mais nova, usando a reserva:', e?.message || e)
    return VERSAO_RESERVA
  }
}

// Estado do pareamento em andamento, lido pela página via /estado.
let estado = { fase: 'ocioso', codigo: null, numero: null, mensagem: null, sessionId: null }
let socketAtivo = null

function jaPareado() {
  return fs.existsSync(path.join(AUTH_DIR, 'creds.json'))
}

function apagarSessao() {
  if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true })
}

function encerrarSocket() {
  if (!socketAtivo) return
  try { socketAtivo.end() } catch (e) { /* já estava fechado */ }
  socketAtivo = null
}

// --- session id (export) ---------------------------------------------

function credsComprimido() {
  const creds = fs.readFileSync(path.join(AUTH_DIR, 'creds.json'))
  return zlib.gzipSync(creds).toString('base64url')
}

// Longo (auto-contido): a sessão inteira dentro da própria string. Não
// depende de nada externo, sempre funciona, só fica grande.
function sessionIdLongo() {
  return `${PREFIXO_SESSION}~${credsComprimido()}`
}

// Curto (~40 caracteres): sobe a sessão pra um Gist SECRETO do GitHub e
// devolve só a referência. Precisa de GITHUB_TOKEN (escopo "gist").
// Devolve null se não tiver token (quem chamou cai pro longo).
async function sessionIdCurto() {
  if (!GITHUB_TOKEN) return null
  const resp = await fetch('https://api.github.com/gists', {
    method: 'POST',
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'pareamento-site',
    },
    body: JSON.stringify({
      description: 'wa-session',
      public: false,
      files: { 'session.txt': { content: credsComprimido() } },
    }),
  })
  if (!resp.ok) throw new Error(`Falha ao criar o Gist (HTTP ${resp.status}).`)
  const json = await resp.json()
  return `${PREFIXO_SESSION}~${json.id}`
}

// --- fluxo de conexão ---------------------------------------------------

// Roda quando o socket termina de conectar: gera o session id, manda pro
// próprio chat do WhatsApp, e guarda em `estado` pra a página mostrar
// também (não depende só da mensagem chegar no WhatsApp).
async function tratarConectado(sock) {
  try {
    // Dá um instante pro baileys terminar de gravar as chaves no disco.
    await delay(3000)

    let sessionId
    try {
      sessionId = await sessionIdCurto()
      if (sessionId) console.log('[PAREAMENTO] session id curto (via Gist)')
    } catch (e) {
      console.log('[PAREAMENTO] Gist falhou, usando id longo:', e?.message || e)
    }
    if (!sessionId) {
      sessionId = sessionIdLongo()
      console.log('[PAREAMENTO] session id longo (sem GITHUB_TOKEN ou Gist falhou)')
    }

    try {
      const proprioChat = jidNormalizedUser(sock.user.id)
      await sock.sendMessage(proprioChat, {
        text: '✅ *Conectado com sucesso!*\n\nSegue abaixo o seu *SESSION ID* — guarde em segredo.',
      })
      await sock.sendMessage(proprioChat, { text: sessionId })
      console.log('[PAREAMENTO] session id enviado pro WhatsApp com sucesso')
    } catch (e) {
      // Não é crítico: o id já está em `estado.sessionId` pra página mostrar
      // de qualquer jeito, mesmo que o envio pro WhatsApp falhe.
      console.log('[PAREAMENTO] não consegui enviar o session id pro WhatsApp:', e?.message || e)
    }

    estado = { ...estado, fase: 'conectado', mensagem: 'Conectado! A sessão foi gravada.', sessionId }
  } catch (e) {
    console.log('[PAREAMENTO] ERRO ao finalizar a conexão:', e?.message || e)
    estado = { ...estado, fase: 'conectado', mensagem: 'Conectado (sessão gravada), mas houve um erro ao gerar o session id.', sessionId: null }
  } finally {
    await delay(500)
    encerrarSocket()
  }
}

// Abre um socket pra AUTH_DIR atual. semPedirCodigo=true é usado na
// reconexão automática depois que a pessoa já digitou o código (ver
// DisconnectReason.restartRequired abaixo) — nesse caso NÃO pede código
// de novo, só reabre a conexão pra ela se completar.
async function abrirSocket(numero, semPedirCodigo) {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const version = await versaoWhatsApp()
  console.log('[PAREAMENTO] usando versão do WhatsApp Web:', version.join('.'))

  // 🐛 Bug real confirmado ao vivo, lendo o código-fonte do innova: o
  // pareamento por código só é aceito pelo servidor do WhatsApp com o
  // browser no preset Browsers.android() (vira "Chrome (Android)"
  // internamente). Qualquer outro formato (ex: "Chrome (Ubuntu)") o
  // servidor DESCARTA EM SILÊNCIO — o socket fica preso em "connecting"
  // pra sempre, sem erro nenhum, e o WhatsApp mostra "não foi possível
  // conectar o dispositivo". O aparelho aparece como "Android" em
  // Aparelhos Conectados — é esperado, é assim que esse mecanismo funciona.
  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: Browsers.android(''),
  })
  socketAtivo = sock

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection) {
      const sc = lastDisconnect?.error?.output?.statusCode
      console.log('[PAREAMENTO] connection:', connection, sc !== undefined ? `(status ${sc})` : '')
    }

    if (connection === 'open') {
      return tratarConectado(sock)
    }

    if (connection === 'close') {
      if (estado.fase === 'conectado') return // já tinha concluído, fechamento normal

      const sc = lastDisconnect?.error?.output?.statusCode

      if (sc === DisconnectReason.loggedOut) {
        estado = { ...estado, fase: 'erro', mensagem: 'A sessão foi encerrada. Gere um código novo.' }
        return encerrarSocket()
      }

      // 🐛 restartRequired (515) é PARTE NORMAL do pareamento: depois que a
      // pessoa digita o código, o baileys fecha com 515 e SÓ completa o
      // login quando o socket é recriado. Sem reconectar aqui, o pareamento
      // ficava "só conectando" pra sempre mesmo com o código certo.
      if (sc === DisconnectReason.restartRequired) {
        await delay(2000)
        return abrirSocket(numero, true)
      }

      // Qualquer outra queda ANTES do código ter sido entregue (erro de
      // rede no handshake inicial): tenta de novo do zero.
      if (!estado.codigo) {
        await delay(3000)
        return abrirSocket(numero, false)
      }

      // Depois do código já entregue, uma queda que não é 515 nem logout é
      // erro de verdade — não adianta reconectar sozinho, precisa de um
      // código novo.
      estado = { ...estado, fase: 'erro', mensagem: 'A conexão caiu antes de concluir. Gere um código novo.' }
      encerrarSocket()
    }
  })

  if (!semPedirCodigo) {
    // O socket precisa de um instante pra fazer o handshake inicial antes
    // de aceitar o pedido de código.
    await delay(3000)
    try {
      const codigo = await sock.requestPairingCode(numero)
      console.log('[PAREAMENTO] código gerado:', codigo)
      estado = { ...estado, codigo }
    } catch (e) {
      console.log('[PAREAMENTO] ERRO ao gerar o código:', e?.message || e)
      throw e
    }
  }
}

// Inicia um pareamento novo: apaga a sessão anterior (o código só pode ser
// pedido por uma sessão ainda não registrada) e abre o socket.
async function iniciarPareamento(numero) {
  encerrarSocket()
  apagarSessao()
  estado = { fase: 'aguardando', codigo: null, numero, mensagem: null, sessionId: null }
  await abrirSocket(numero, false)
  return estado.codigo
}

const PAGINA = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pareamento - XAVIER-MD</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #0f1020; color: #e8e8f0; padding: 20px;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  .cartao {
    width: 100%; max-width: 420px; background: #191a30; border: 1px solid #2a2c4d;
    border-radius: 16px; padding: 28px;
  }
  h1 { margin: 0 0 4px; font-size: 21px; }
  .sub { margin: 0 0 22px; color: #9a9ac0; font-size: 14px; }
  label { display: block; font-size: 13px; color: #9a9ac0; margin-bottom: 7px; }
  input {
    width: 100%; padding: 13px 14px; font-size: 16px; border-radius: 10px;
    border: 1px solid #33355c; background: #101122; color: #fff;
  }
  input:focus { outline: none; border-color: #6c5ce7; }
  button {
    width: 100%; margin-top: 14px; padding: 13px; font-size: 15px; font-weight: 600;
    border: 0; border-radius: 10px; background: #6c5ce7; color: #fff; cursor: pointer;
  }
  button:disabled { opacity: .55; cursor: default; }
  .caixa { margin-top: 22px; padding: 18px; border-radius: 12px; background: #101122; border: 1px solid #2a2c4d; }
  .codigo {
    font-size: 34px; font-weight: 700; letter-spacing: 5px; text-align: center;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; color: #7ee787;
    word-break: break-all;
  }
  .passos { margin: 14px 0 0; padding-left: 18px; color: #b9b9d8; font-size: 13.5px; line-height: 1.65; }
  .aviso { margin-top: 16px; font-size: 13px; padding: 12px 14px; border-radius: 10px; }
  .erro { background: #3a1620; border: 1px solid #7a2740; color: #ffb3c0; }
  .ok { background: #123024; border: 1px solid #1e5a3c; color: #86efac; }
  .oculto { display: none; }
  .sessioncaixa {
    margin-top: 16px; padding: 14px; border-radius: 10px; background: #101122;
    border: 1px solid #2a2c4d; word-break: break-all; font-family: ui-monospace, monospace;
    font-size: 12px; color: #7ee787; cursor: pointer;
  }
</style>
</head>
<body>
<div class="cartao">
  <h1>Conectar o bot</h1>
  <p class="sub">Gere o código e digite no seu WhatsApp.</p>

  <div id="form">
    <label for="numero">Número com DDI (só números)</label>
    <input id="numero" inputmode="numeric" placeholder="5565999999999" autocomplete="off">
    <button id="botao">Gerar código</button>
  </div>

  <div id="resultado" class="caixa oculto">
    <div class="codigo" id="codigo">--------</div>
    <ol class="passos">
      <li>Abra o WhatsApp no celular</li>
      <li>Toque em <b>Aparelhos conectados</b></li>
      <li><b>Conectar um aparelho</b> &rarr; <b>Conectar com número de telefone</b></li>
      <li>Digite o código acima</li>
    </ol>
  </div>

  <div id="aviso" class="aviso oculto"></div>
  <div id="sessionBox" class="sessioncaixa oculto" title="toque para copiar"></div>
</div>

<script>
  const token = new URLSearchParams(location.search).get('token') || '';
  const $ = (id) => document.getElementById(id);
  let polling = null;

  function mostrarAviso(texto, tipo) {
    const el = $('aviso');
    el.textContent = texto;
    el.className = 'aviso ' + tipo;
  }

  async function gerar() {
    const numero = $('numero').value.replace(/[^0-9]/g, '');
    if (numero.length < 10) return mostrarAviso('Digite o número completo, com DDI e DDD.', 'erro');

    $('botao').disabled = true;
    $('botao').textContent = 'Gerando...';
    $('aviso').className = 'aviso oculto';

    try {
      const r = await fetch('/parear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ numero, token })
      });
      const dados = await r.json();
      if (!r.ok) throw new Error(dados.erro || 'Falha ao gerar o código.');

      $('codigo').textContent = (dados.codigo.match(/.{1,4}/g) || [dados.codigo]).join('-');
      $('resultado').classList.remove('oculto');
      $('form').classList.add('oculto');
      polling = setInterval(checar, 2000);
    } catch (e) {
      mostrarAviso(e.message, 'erro');
      $('botao').disabled = false;
      $('botao').textContent = 'Gerar código';
    }
  }

  async function checar() {
    try {
      const r = await fetch('/estado?token=' + encodeURIComponent(token));
      const s = await r.json();
      if (s.fase === 'conectado') {
        clearInterval(polling);
        mostrarAviso('Conectado! Também mandei o session id pro seu WhatsApp.', 'ok');
        if (s.sessionId) {
          const box = $('sessionBox');
          box.textContent = s.sessionId;
          box.classList.remove('oculto');
          box.onclick = () => { navigator.clipboard && navigator.clipboard.writeText(s.sessionId) };
        }
      } else if (s.fase === 'erro') {
        clearInterval(polling);
        mostrarAviso(s.mensagem || 'A conexão caiu. Recarregue e tente de novo.', 'erro');
      }
    } catch (e) { /* servidor reiniciando, tenta no próximo ciclo */ }
  }

  $('botao').addEventListener('click', gerar);
  $('numero').addEventListener('keydown', (e) => { if (e.key === 'Enter') gerar(); });
</script>
</body>
</html>`

function responderJson(res, status, dados) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(dados))
}

function tokenValido(recebido) {
  if (!TOKEN) return true // sem token configurado, o servidor já está preso no localhost
  return recebido === TOKEN
}

// Lê e faz parse do corpo JSON de um POST — usado tanto pelo /parear quanto
// pelas rotas /api/* de imagem (evita repetir o mesmo req.on('data'/'end')
// em cada uma).
function lerCorpoJson(req, limiteBytes = 2e4) {
  return new Promise((resolve, reject) => {
    let corpo = ''
    req.on('data', (p) => {
      corpo += p
      if (corpo.length > limiteBytes) { req.destroy(); reject(new Error('Corpo grande demais.')) }
    })
    req.on('end', () => {
      try { resolve(JSON.parse(corpo || '{}')) } catch (e) { reject(new Error('JSON inválido.')) }
    })
    req.on('error', reject)
  })
}

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)

  if (req.method === 'GET' && url.pathname === '/') {
    if (!tokenValido(url.searchParams.get('token'))) {
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' })
      return res.end('Acesso negado: informe ?token=SUA_SENHA na URL.')
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    return res.end(PAGINA)
  }

  if (req.method === 'GET' && url.pathname === '/estado') {
    if (!tokenValido(url.searchParams.get('token'))) return responderJson(res, 401, { erro: 'token inválido' })
    return responderJson(res, 200, { fase: estado.fase, mensagem: estado.mensagem, sessionId: estado.sessionId })
  }

  if (req.method === 'POST' && url.pathname === '/parear') {
    let corpo = ''
    req.on('data', (p) => {
      corpo += p
      if (corpo.length > 1e4) req.destroy() // não aceita corpo absurdo
    })
    req.on('end', async () => {
      try {
        const { numero: bruto, token } = JSON.parse(corpo || '{}')
        if (!tokenValido(token)) return responderJson(res, 401, { erro: 'Token inválido.' })

        const numero = String(bruto || '').replace(/[^0-9]/g, '')
        if (numero.length < 10) return responderJson(res, 400, { erro: 'Número inválido. Use DDI + DDD + número.' })
        if (estado.fase === 'aguardando') return responderJson(res, 409, { erro: 'Já existe um pareamento em andamento. Recarregue a página.' })

        const codigo = await iniciarPareamento(numero)
        return responderJson(res, 200, { codigo })
      } catch (e) {
        estado = { fase: 'erro', codigo: null, numero: null, mensagem: e.message, sessionId: null }
        encerrarSocket()
        return responderJson(res, 500, { erro: 'Não consegui gerar o código: ' + e.message })
      }
    })
    return
  }

  // --- API de imagem (canvafy/@napi-rs/canvas) pro XAVIER-MD -----------
  // Fica aqui (e não no bot) de propósito: essas libs precisam de binário
  // nativo, e é justamente isso que trava instalação em Termux/ARM64. Rodando
  // só nesta hospedagem, o bot chama por HTTP e nunca precisa instalar nada
  // pesado. Mesmo esquema de token do resto do site (corpo JSON, campo
  // "token"), resposta em base64 dentro de JSON (mais simples de consumir
  // via axios do que teria que trocar de responseType pra binário).
  if (req.method === 'POST' && url.pathname === '/api/welcome-card') {
    try {
      const corpo = await lerCorpoJson(req)
      if (!tokenValido(corpo.token)) return responderJson(res, 401, { erro: 'Token inválido.' })
      if (!corpo.avatarUrl) return responderJson(res, 400, { erro: 'avatarUrl é obrigatório.' })
      const buffer = await gerarWelcomeCard(corpo)
      return responderJson(res, 200, { imagem: buffer.toString('base64') })
    } catch (e) {
      return responderJson(res, 500, { erro: e.message })
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/gfx') {
    try {
      const corpo = await lerCorpoJson(req)
      if (!tokenValido(corpo.token)) return responderJson(res, 401, { erro: 'Token inválido.' })
      if (!corpo.texto) return responderJson(res, 400, { erro: 'texto é obrigatório.' })
      const buffer = await gerarGfx(corpo)
      return responderJson(res, 200, { imagem: buffer.toString('base64') })
    } catch (e) {
      return responderJson(res, 500, { erro: e.message })
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/figurinha-texto') {
    try {
      const corpo = await lerCorpoJson(req)
      if (!tokenValido(corpo.token)) return responderJson(res, 401, { erro: 'Token inválido.' })
      if (!corpo.texto) return responderJson(res, 400, { erro: 'texto é obrigatório.' })
      const frames = gerarFramesFigurinha(corpo)
      return responderJson(res, 200, { frames: frames.map((f) => f.toString('base64')) })
    } catch (e) {
      return responderJson(res, 500, { erro: e.message })
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('Não encontrado')
})

servidor.listen(PORTA, HOST, () => {
  console.log(`\n🔗 Pareamento em http://${HOST === '0.0.0.0' ? 'SEU-IP' : 'localhost'}:${PORTA}${TOKEN ? '/?token=' + TOKEN : ''}`)
  if (!TOKEN) {
    console.log('   (só acessível nesta máquina — para abrir pra internet, defina PAREAMENTO_TOKEN)')
  } else {
    console.log('   ⚠️  aberto pra internet, protegido pelo token acima')
  }
  console.log(`\n📁 A sessão será gravada em:\n   ${AUTH_DIR}`)
  if (!PASTA_SESSAO) {
    console.log('   Depois de conectar, copie essa pasta para database/baileys/ do bot')
    console.log('   (ou aponte PASTA_SESSAO direto pra pasta dele, ou use o session id).')
  }
  console.log(GITHUB_TOKEN
    ? '   🔑 GITHUB_TOKEN configurado: o session id vai sair curto (via Gist secreto).'
    : '   ℹ️  sem GITHUB_TOKEN: o session id vai sair longo (auto-contido, funciona igual).')
  if (jaPareado()) {
    console.log('\n   ℹ️  já existe uma sessão aí; gerar um código novo vai substituí-la.\n')
  } else {
    console.log('')
  }
})
