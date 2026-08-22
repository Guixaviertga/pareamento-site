'use strict'
// Geração de imagem (canvas) do pareamento-site, servida via API HTTP pro
// XAVIER-MD. Motivo de morar AQUI e não no bot: canvafy/@napi-rs/canvas são
// as únicas dependências "pesadas" do bot (binário nativo por trás) — numa
// máquina restrita (Termux, Pterodactyl ARM64) instalar isso é a maior fonte
// de dor de cabeça da sessão toda. Rodando só aqui (site, geralmente numa
// hospedagem "normal" tipo Railway), o bot nunca precisa instalar nada disso
// — só chama a API e recebe o PNG pronto.
const fs = require('fs')
const path = require('path')
const { WelcomeLeave } = require('canvafy')
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas')

const PASTA_GFX = path.join(__dirname, 'midia', 'gfx')
const PASTA_FONTES = path.join(__dirname, 'midia', 'fontes')

const FONTES = {
  badabb: 'BADABB__.TTF',
  vampire: 'Vampire Wars.ttf',
  speedbeast: 'SpeedBeast FREE.ttf',
  avengeance: 'AVENGEANCE HEROIC AVENGER.ttf',
  bells: 'Bells Morten.ttf',
  castillo: 'Castillo.ttf',
  mix: 'Mix Doodle.ttf',
  lemands: 'Lemands.ttf',
}
const FONTE_PADRAO = 'badabb'

let fontesRegistradas = false
function registrarFontes() {
  if (fontesRegistradas) return
  for (const [nome, arquivo] of Object.entries(FONTES)) {
    const caminho = path.join(PASTA_FONTES, arquivo)
    if (fs.existsSync(caminho)) GlobalFonts.registerFromPath(caminho, nome)
  }
  fontesRegistradas = true
}

// --- welcome-card (canvafy) ---------------------------------------------
const LIMITE_TITULO = 20
const LIMITE_DESCRICAO = 80
function truncar(texto, max) {
  if (!texto) return texto
  return texto.length > max ? `${texto.slice(0, max - 1)}…` : texto
}

async function gerarWelcomeCard({ avatarUrl, tipo, titulo, descricao, fundoUrls }) {
  const card = new WelcomeLeave().setAvatar(avatarUrl)

  if (Array.isArray(fundoUrls) && fundoUrls.length > 0) {
    const escolhido = fundoUrls[Math.floor(Math.random() * fundoUrls.length)]
    card.setBackground('image', escolhido)
  } else {
    card.setBackground('color', '#23272A')
  }

  card
    .setTitle(truncar(titulo, LIMITE_TITULO))
    .setDescription(truncar(descricao, LIMITE_DESCRICAO))
    .setBorder('#ffffff')
    .setAvatarBorder(tipo === 'add' ? '#43b581' : '#f04747')
    .setOverlayOpacity(0.5)
  return card.build()
}

// --- gfx (texto sobre imagem de fundo) ----------------------------------
function listarFundosGfx() {
  if (!fs.existsSync(PASTA_GFX)) return []
  return fs.readdirSync(PASTA_GFX)
    .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
    .sort()
    .map((f) => path.join(PASTA_GFX, f))
}

function ajustarFonte(ctx, texto, fonte, larguraMax, tamanhoInicial) {
  let tam = tamanhoInicial
  while (tam > 10) {
    ctx.font = `${tam}px ${fonte}`
    if (ctx.measureText(texto).width <= larguraMax) break
    tam -= 2
  }
  return tam
}

function escreverGfx(ctx, texto, fonte, x, y, tam, cor) {
  ctx.font = `${tam}px ${fonte}`
  ctx.textAlign = 'center'
  ctx.strokeStyle = '#000000'
  ctx.lineWidth = Math.max(4, tam * 0.13)
  ctx.lineJoin = 'round'
  ctx.shadowColor = 'rgba(0,0,0,0.85)'
  ctx.shadowBlur = tam * 0.12
  ctx.shadowOffsetX = tam * 0.05
  ctx.shadowOffsetY = tam * 0.06
  ctx.strokeText(texto, x, y)
  ctx.fillStyle = cor
  ctx.fillText(texto, x, y)
  ctx.shadowColor = 'transparent'
}

async function gerarGfx({ texto, texto2, template, fonte = FONTE_PADRAO }) {
  registrarFontes()
  const fundos = listarFundosGfx()
  if (!fundos.length) throw new Error('SEM_TEMPLATES')

  const escolhido = template ? fundos[template - 1] : fundos[Math.floor(Math.random() * fundos.length)]
  if (!escolhido) throw new Error('TEMPLATE_INVALIDO')

  const nomeFonte = FONTES[fonte] && fs.existsSync(path.join(PASTA_FONTES, FONTES[fonte])) ? fonte : FONTE_PADRAO

  const img = await loadImage(escolhido)
  const W = img.width
  const H = img.height
  const canvas = createCanvas(W, H)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0, W, H)

  const larguraMax = W * 0.88
  const cx = W / 2
  const tam = ajustarFonte(ctx, texto, nomeFonte, larguraMax, Math.floor(H * 0.16))
  const y = texto2 ? H - H * 0.14 : H - H * 0.09
  escreverGfx(ctx, texto, nomeFonte, cx, y, tam, '#ffffff')

  if (texto2) {
    const tam2 = ajustarFonte(ctx, texto2, nomeFonte, larguraMax, Math.floor(tam * 0.42))
    escreverGfx(ctx, texto2, nomeFonte, cx, H - H * 0.05, tam2, '#ffd23f')
  }

  return canvas.toBuffer('image/png')
}

function contarTemplatesGfx() {
  return listarFundosGfx().length
}

// --- figurinha de texto (ttp/attp) --------------------------------------
// Só desenha os quadros aqui — o encode pra WebP animado (ffmpeg) continua
// no bot, que já tem ffmpeg instalado sem drama nenhum (o problema sempre
// foi só o canvas nativo).
const TAMANHO = 512
const CORES = ['#ff2d2d', '#25d366', '#3b82f6']

function fonteValida(nome) {
  if (nome && FONTES[nome] && fs.existsSync(path.join(PASTA_FONTES, FONTES[nome]))) return nome
  if (fs.existsSync(path.join(PASTA_FONTES, FONTES.badabb))) return 'badabb'
  return 'sans-serif'
}

function montarLinhas(ctx, texto, fonte, larguraMax, alturaMax) {
  const palavras = texto.split(/\s+/).filter(Boolean)
  for (let tam = Math.floor(TAMANHO * 0.34); tam >= 14; tam -= 2) {
    ctx.font = `${tam}px ${fonte}`
    const linhas = []
    let linha = ''
    let coube = true

    for (const palavra of palavras) {
      const teste = linha ? `${linha} ${palavra}` : palavra
      if (ctx.measureText(teste).width <= larguraMax) {
        linha = teste
        continue
      }
      if (linha) linhas.push(linha)
      if (ctx.measureText(palavra).width > larguraMax) { coube = false; break }
      linha = palavra
    }
    if (!coube) continue
    if (linha) linhas.push(linha)

    if (linhas.length * (tam * 1.15) <= alturaMax) return { linhas, tam }
  }
  return { linhas: [texto], tam: 14 }
}

function desenharQuadro(ctx, linhas, tam, fonte, cor) {
  ctx.clearRect(0, 0, TAMANHO, TAMANHO)
  ctx.font = `${tam}px ${fonte}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = '#000000'
  ctx.lineWidth = Math.max(4, tam * 0.14)

  const alturaLinha = tam * 1.15
  const inicioY = TAMANHO / 2 - ((linhas.length - 1) * alturaLinha) / 2

  for (let i = 0; i < linhas.length; i++) {
    const y = inicioY + i * alturaLinha
    ctx.strokeText(linhas[i], TAMANHO / 2, y)
    ctx.fillStyle = cor
    ctx.fillText(linhas[i], TAMANHO / 2, y)
  }
}

// Devolve array de buffers PNG: 1 elemento se animado=false (ttp), vários
// se animado=true (attp — um por quadro, cores ciclando, pro bot montar o
// WebP animado localmente).
function gerarFramesFigurinha({ texto, fonte, animado, fps = 10, duracaoMs = 1000 }) {
  registrarFontes()
  const f = fonteValida(fonte)
  const canvas = createCanvas(TAMANHO, TAMANHO)
  const ctx = canvas.getContext('2d')
  const { linhas, tam } = montarLinhas(ctx, texto, f, TAMANHO * 0.86, TAMANHO * 0.86)

  if (!animado) {
    desenharQuadro(ctx, linhas, tam, f, '#ffffff')
    return [canvas.toBuffer('image/png')]
  }

  const quadrosPorCor = Math.max(1, Math.round(((duracaoMs / 1000) * fps) / CORES.length))
  const totalQuadros = quadrosPorCor * CORES.length
  const frames = []
  for (let i = 0; i < totalQuadros; i++) {
    const cor = CORES[Math.floor(i / quadrosPorCor) % CORES.length]
    desenharQuadro(ctx, linhas, tam, f, cor)
    frames.push(canvas.toBuffer('image/png'))
  }
  return frames
}

module.exports = {
  gerarWelcomeCard,
  gerarGfx,
  contarTemplatesGfx,
  gerarFramesFigurinha,
  FONTES,
}
