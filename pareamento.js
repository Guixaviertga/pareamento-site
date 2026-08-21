'use strict'

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

try {
  require('dotenv').config({ path: path.join(__dirname, '.env') })
} catch (e) {}

let config = {}

try {
  config = require('./config.js') || {}
} catch (e) {}

const PASTA_SESSAO =
  process.env.PASTA_SESSAO ||
  config.PASTA_SESSAO ||
  ''

const AUTH_DIR = PASTA_SESSAO
  ? path.resolve(PASTA_SESSAO)
  : path.join(__dirname, 'sessao', 'baileys')

const PORTA = Number(
  process.env.PAREAMENTO_PORTA ||
  process.env.PORT ||
  config.PAREAMENTO_PORTA ||
  3000
)

const GITHUB_TOKEN = String(
  process.env.GITHUB_TOKEN ||
  config.GITHUB_TOKEN ||
  ''
).trim()

// Railway precisa escutar em 0.0.0.0
const HOST = '0.0.0.0'

const PREFIXO_SESSION = 'XAVIER'

const VERSAO_RESERVA = [2, 3000, 1045297628]

async function versaoWhatsApp() {
  try {
    const { version } = await fetchLatestBaileysVersion()

    return version
  } catch (e) {
    console.log(
      '[PAREAMENTO] não consegui buscar a versão mais nova, usando a reserva:',
      e?.message || e
    )

    return VERSAO_RESERVA
  }
}

let estado = {
  fase: 'ocioso',
  codigo: null,
  numero: null,
  mensagem: null,
  sessionId: null
}

let socketAtivo = null

function jaPareado() {
  return fs.existsSync(
    path.join(AUTH_DIR, 'creds.json')
  )
}

function apagarSessao() {
  if (fs.existsSync(AUTH_DIR)) {
    fs.rmSync(AUTH_DIR, {
      recursive: true,
      force: true
    })
  }
}

function encerrarSocket() {
  if (!socketAtivo) return

  try {
    socketAtivo.end()
  } catch (e) {}

  socketAtivo = null
}

// ============================================================
// SESSION ID
// ============================================================

function credsComprimido() {
  const creds = fs.readFileSync(
    path.join(AUTH_DIR, 'creds.json')
  )

  return zlib
    .gzipSync(creds)
    .toString('base64url')
}

function sessionIdLongo() {
  return `${PREFIXO_SESSION}~${credsComprimido()}`
}

// Cria um Gist privado e retorna um ID curto
async function sessionIdCurto() {
  if (!GITHUB_TOKEN) {
    console.log(
      '[PAREAMENTO] GITHUB_TOKEN não configurado.'
    )

    return null
  }

  const resp = await fetch(
    'https://api.github.com/gists',
    {
      method: 'POST',

      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'pareamento-site'
      },

      body: JSON.stringify({
        description: 'wa-session',

        public: false,

        files: {
          'session.txt': {
            content: credsComprimido()
          }
        }
      })
    }
  )

  if (!resp.ok) {
    const texto = await resp.text()

    throw new Error(
      `Falha ao criar o Gist (HTTP ${resp.status}): ${texto}`
    )
  }

  const json = await resp.json()

  if (!json.id) {
    throw new Error(
      'GitHub não retornou o ID do Gist.'
    )
  }

  return `${PREFIXO_SESSION}~${json.id}`
}

// ============================================================
// CONEXÃO
// ============================================================

async function tratarConectado(sock) {
  try {
    await delay(3000)

    let sessionId

    try {
      sessionId = await sessionIdCurto()

      if (sessionId) {
        console.log(
          '[PAREAMENTO] session id curto gerado via Gist:',
          sessionId
        )
      }
    } catch (e) {
      console.log(
        '[PAREAMENTO] Gist falhou:',
        e?.message || e
      )
    }

    if (!sessionId) {
      sessionId = sessionIdLongo()

      console.log(
        '[PAREAMENTO] usando session id longo.'
      )
    }

    try {
      const proprioChat = jidNormalizedUser(
        sock.user.id
      )

      await sock.sendMessage(
        proprioChat,
        {
          text:
            '✅ *Conectado com sucesso!*\n\n' +
            'Segue abaixo o seu *SESSION ID* — guarde em segredo.'
        }
      )

      await sock.sendMessage(
        proprioChat,
        {
          text: sessionId
        }
      )

      console.log(
        '[PAREAMENTO] session id enviado para o WhatsApp.'
      )
    } catch (e) {
      console.log(
        '[PAREAMENTO] não consegui enviar o session id:',
        e?.message || e
      )
    }

    estado = {
      ...estado,
      fase: 'conectado',
      mensagem: 'Conectado! A sessão foi gravada.',
      sessionId
    }
  } catch (e) {
    console.log(
      '[PAREAMENTO] ERRO ao finalizar conexão:',
      e?.message || e
    )

    estado = {
      ...estado,
      fase: 'conectado',
      mensagem:
        'Conectado, mas houve um erro ao gerar o session id.',
      sessionId: null
    }
  } finally {
    await delay(500)

    encerrarSocket()
  }
}

async function abrirSocket(numero, semPedirCodigo) {
  const {
    state,
    saveCreds
  } = await useMultiFileAuthState(AUTH_DIR)

  const version = await versaoWhatsApp()

  console.log(
    '[PAREAMENTO] usando versão do WhatsApp Web:',
    version.join('.')
  )

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({
      level: 'silent'
    }),
    browser: Browsers.android('')
  })

  socketAtivo = sock

  sock.ev.on(
    'creds.update',
    saveCreds
  )

  sock.ev.on(
    'connection.update',
    async ({
      connection,
      lastDisconnect
    }) => {
      if (connection) {
        const sc =
          lastDisconnect?.error?.output?.statusCode

        console.log(
          '[PAREAMENTO] connection:',
          connection,
          sc !== undefined
            ? `(status ${sc})`
            : ''
        )
      }

      if (connection === 'open') {
        return tratarConectado(sock)
      }

      if (connection === 'close') {
        if (estado.fase === 'conectado') {
          return
        }

        const sc =
          lastDisconnect?.error?.output?.statusCode

        if (
          sc === DisconnectReason.loggedOut
        ) {
          estado = {
            ...estado,
            fase: 'erro',
            mensagem:
              'A sessão foi encerrada. Gere um código novo.'
          }

          return encerrarSocket()
        }

        if (
          sc === DisconnectReason.restartRequired
        ) {
          await delay(2000)

          return abrirSocket(
            numero,
            true
          )
        }

        if (!estado.codigo) {
          await delay(3000)

          return abrirSocket(
            numero,
            false
          )
        }

        estado = {
          ...estado,
          fase: 'erro',
          mensagem:
            'A conexão caiu antes de concluir. Gere um código novo.'
        }

        encerrarSocket()
      }
    }
  )

  if (!semPedirCodigo) {
    await delay(3000)

    try {
      const codigo =
        await sock.requestPairingCode(numero)

      console.log(
        '[PAREAMENTO] código gerado:',
        codigo
      )

      estado = {
        ...estado,
        codigo
      }

      return codigo
    } catch (e) {
      console.log(
        '[PAREAMENTO] ERRO ao gerar código:',
        e?.message || e
      )

      throw e
    }
  }
}

async function iniciarPareamento(numero) {
  encerrarSocket()

  apagarSessao()

  estado = {
    fase: 'aguardando',
    codigo: null,
    numero,
    mensagem: null,
    sessionId: null
  }

  await abrirSocket(
    numero,
    false
  )

  return estado.codigo
}

// ============================================================
// PÁGINA
// ============================================================

const PAGINA = `<!doctype html>
<html lang="pt-BR">

<head>

<meta charset="utf-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1"
>

<title>Pareamento - XAVIER-MD</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #0f1020;
  color: #e8e8f0;
  padding: 20px;
  font-family:
    system-ui,
    -apple-system,
    "Segoe UI",
    Roboto,
    sans-serif;
}

.cartao {
  width: 100%;
  max-width: 420px;
  background: #191a30;
  border: 1px solid #2a2c4d;
  border-radius: 16px;
  padding: 28px;
}

h1 {
  margin: 0 0 4px;
  font-size: 21px;
}

.sub {
  margin: 0 0 22px;
  color: #9a9ac0;
  font-size: 14px;
}

label {
  display: block;
  font-size: 13px;
  color: #9a9ac0;
  margin-bottom: 7px;
}

input {
  width: 100%;
  padding: 13px 14px;
  font-size: 16px;
  border-radius: 10px;
  border: 1px solid #33355c;
  background: #101122;
  color: #fff;
}

input:focus {
  outline: none;
  border-color: #6c5ce7;
}

button {
  width: 100%;
  margin-top: 14px;
  padding: 13px;
  font-size: 15px;
  font-weight: 600;
  border: 0;
  border-radius: 10px;
  background: #6c5ce7;
  color: #fff;
  cursor: pointer;
}

button:disabled {
  opacity: .55;
  cursor: default;
}

.caixa {
  margin-top: 22px;
  padding: 18px;
  border-radius: 12px;
  background: #101122;
  border: 1px solid #2a2c4d;
}

.codigo {
  font-size: 34px;
  font-weight: 700;
  letter-spacing: 5px;
  text-align: center;
  font-family:
    ui-monospace,
    "SF Mono",
    Menlo,
    Consolas,
    monospace;
  color: #7ee787;
  word-break: break-all;
}

.passos {
  margin: 14px 0 0;
  padding-left: 18px;
  color: #b9b9d8;
  font-size: 13.5px;
  line-height: 1.65;
}

.aviso {
  margin-top: 16px;
  font-size: 13px;
  padding: 12px 14px;
  border-radius: 10px;
}

.erro {
  background: #3a1620;
  border: 1px solid #7a2740;
  color: #ffb3c0;
}

.ok {
  background: #123024;
  border: 1px solid #1e5a3c;
  color: #86efac;
}

.oculto {
  display: none;
}

.sessioncaixa {
  margin-top: 16px;
  padding: 14px;
  border-radius: 10px;
  background: #101122;
  border: 1px solid #2a2c4d;
  word-break: break-all;
  font-family: ui-monospace, monospace;
  font-size: 12px;
  color: #7ee787;
  cursor: pointer;
}

</style>

</head>

<body>

<div class="cartao">

<h1>Conectar o bot</h1>

<p class="sub">
Gere o código e digite no seu WhatsApp.
</p>

<div id="form">

<label for="numero">
Número com DDI (só números)
</label>

<input
  id="numero"
  inputmode="numeric"
  placeholder="5565999999999"
  autocomplete="off"
>

<button id="botao">
Gerar código
</button>

</div>

<div
  id="resultado"
  class="caixa oculto"
>

<div
  class="codigo"
  id="codigo"
>
--------
</div>

<ol class="passos">

<li>
Abra o WhatsApp no celular
</li>

<li>
Toque em <b>Aparelhos conectados</b>
</li>

<li>
<b>Conectar um aparelho</b>
→
<b>Conectar com número de telefone</b>
</li>

<li>
Digite o código acima
</li>

</ol>

</div>

<div
  id="aviso"
  class="aviso oculto"
></div>

<div
  id="sessionBox"
  class="sessioncaixa oculto"
  title="toque para copiar"
></div>

</div>

<script>

const $ = (id) =>
  document.getElementById(id)

let polling = null

function mostrarAviso(texto, tipo) {

  const el = $('aviso')

  el.textContent = texto

  el.className =
    'aviso ' + tipo

}

async function gerar() {

  const numero =
    $('numero')
      .value
      .replace(/[^0-9]/g, '')

  if (numero.length < 10) {

    return mostrarAviso(
      'Digite o número completo, com DDI e DDD.',
      'erro'
    )

  }

  $('botao').disabled = true

  $('botao').textContent =
    'Gerando...'

  $('aviso').className =
    'aviso oculto'

  try {

    const r =
      await fetch(
        '/parear',
        {
          method: 'POST',

          headers: {
            'Content-Type':
              'application/json'
          },

          body: JSON.stringify({
            numero
          })
        }
      )

    const dados =
      await r.json()

    if (!r.ok) {
      throw new Error(
        dados.erro ||
        'Falha ao gerar o código.'
      )
    }

    $('codigo').textContent =
      (
        dados.codigo
          .match(/.{1,4}/g) ||
        [dados.codigo]
      ).join('-')

    $('resultado')
      .classList
      .remove('oculto')

    $('form')
      .classList
      .add('oculto')

    polling =
      setInterval(
        checar,
        2000
      )

  } catch (e) {

    mostrarAviso(
      e.message,
      'erro'
    )

    $('botao').disabled =
      false

    $('botao').textContent =
      'Gerar código'
  }
}

async function checar() {

  try {

    const r =
      await fetch('/estado')

    const s =
      await r.json()

    if (
      s.fase ===
      'conectado'
    ) {

      clearInterval(
        polling
      )

      mostrarAviso(
        'Conectado! Também mandei o session id pro seu WhatsApp.',
        'ok'
      )

      if (s.sessionId) {

        const box =
          $('sessionBox')

        box.textContent =
          s.sessionId

        box.classList
          .remove('oculto')

        box.onclick = () => {

          if (
            navigator.clipboard
          ) {

            navigator.clipboard
              .writeText(
                s.sessionId
              )

          }

        }

      }

    } else if (
      s.fase ===
      'erro'
    ) {

      clearInterval(
        polling
      )

      mostrarAviso(
        s.mensagem ||
        'A conexão caiu. Recarregue e tente de novo.',
        'erro'
      )

    }

  } catch (e) {}

}

$('botao')
  .addEventListener(
    'click',
    gerar
  )

$('numero')
  .addEventListener(
    'keydown',
    (e) => {

      if (
        e.key ===
        'Enter'
      ) {

        gerar()

      }

    }
  )

</script>

</body>

</html>`

// ============================================================
// HTTP
// ============================================================

function responderJson(
  res,
  status,
  dados
) {

  res.writeHead(
    status,
    {
      'Content-Type':
        'application/json; charset=utf-8'
    }
  )

  res.end(
    JSON.stringify(dados)
  )
}

const servidor =
  http.createServer(
    async (req, res) => {

      const url =
        new URL(
          req.url,
          `http://${req.headers.host}`
        )

      // Página principal
      if (
        req.method === 'GET' &&
        url.pathname === '/'
      ) {

        res.writeHead(
          200,
          {
            'Content-Type':
              'text/html; charset=utf-8'
          }
        )

        return res.end(
          PAGINA
        )
      }

      // Estado do pareamento
      if (
        req.method === 'GET' &&
        url.pathname === '/estado'
      ) {

        return responderJson(
          res,
          200,
          {
            fase:
              estado.fase,

            mensagem:
              estado.mensagem,

            sessionId:
              estado.sessionId
          }
        )
      }

      // Gerar código
      if (
        req.method === 'POST' &&
        url.pathname === '/parear'
      ) {

        let corpo = ''

        req.on(
          'data',
          (p) => {

            corpo += p

            if (
              corpo.length >
              1e4
            ) {

              req.destroy()

            }

          }
        )

        req.on(
          'end',
          async () => {

            try {

              const {
                numero: bruto
              } =
                JSON.parse(
                  corpo || '{}'
                )

              const numero =
                String(
                  bruto || ''
                )
                .replace(
                  /[^0-9]/g,
                  ''
                )

              if (
                numero.length <
                10
              ) {

                return responderJson(
                  res,
                  400,
                  {
                    erro:
                      'Número inválido. Use DDI + DDD + número.'
                  }
                )

              }

              if (
                estado.fase ===
                'aguardando'
              ) {

                return responderJson(
                  res,
                  409,
                  {
                    erro:
                      'Já existe um pareamento em andamento. Recarregue a página.'
                  }
                )

              }

              const codigo =
                await iniciarPareamento(
                  numero
                )

              return responderJson(
                res,
                200,
                {
                  codigo
                }
              )

            } catch (e) {

              estado = {
                fase: 'erro',
                codigo: null,
                numero: null,
                mensagem:
                  e.message,
                sessionId: null
              }

              encerrarSocket()

              return responderJson(
                res,
                500,
                {
                  erro:
                    'Não consegui gerar o código: ' +
                    e.message
                }
              )

            }

          }
        )

        return
      }

      res.writeHead(
        404,
        {
          'Content-Type':
            'text/plain; charset=utf-8'
        }
      )

      res.end(
        'Não encontrado'
      )
    }
  )

servidor.listen(
  PORTA,
  HOST,
  () => {

    console.log(
      `\n🔗 Pareamento em http://0.0.0.0:${PORTA}`
    )

    console.log(
      '   🌐 Site público — sem senha.'
    )

    console.log(
      `\n📁 A sessão será gravada em:\n   ${AUTH_DIR}`
    )

    if (!PASTA_SESSAO) {

      console.log(
        '   Depois de conectar, copie essa pasta para database/baileys do bot.'
      )

      console.log(
        '   Ou use PASTA_SESSAO diretamente.'
      )

    }

    if (GITHUB_TOKEN) {

      console.log(
        '   🔑 GITHUB_TOKEN configurado: Session ID curto via Gist privado.'
      )

    } else {

      console.log(
        '   ⚠️ GITHUB_TOKEN não configurado: Session ID será longo.'
      )

    }

    if (jaPareado()) {

      console.log(
        '\n⚠️ Já existe uma sessão. Um novo pareamento substituirá a anterior.\n'
      )

    } else {

      console.log('')

    }

  }
)