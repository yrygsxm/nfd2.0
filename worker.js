// === Cloudflare Worker Telegram Relay Bot with Arithmetic Captcha Gate ===
// This file is a drop-in replacement for your previous worker.js.
// Required Bindings (in Cloudflare dashboard):
//  - KV Namespace binding: nfd
//  - Environment variables: ENV_BOT_TOKEN, ENV_BOT_SECRET, ENV_ADMIN_UID
//
// Endpoints:
//  - /endpoint                -> Telegram webhook
//  - /registerWebhook         -> Register webhook to this worker URL (GET from your browser)
//  - /unRegisterWebhook       -> Remove webhook
//
// Notes:
//  - Guests must pass a simple arithmetic captcha before their messages are forwarded.
//  - Admin (ENV_ADMIN_UID) is not gated.
//  - Supports /block, /unblock, /checkblock (admin replies to a forwarded message).
//  - Sends a start message from startMessage.md and optional periodic notification text.
//  - Minimal changes needed to your KV data structure; safe to paste over existing project.

const TOKEN = ENV_BOT_TOKEN // Get it from @BotFather
const WEBHOOK = '/endpoint'
const SECRET = ENV_BOT_SECRET // A-Z, a-z, 0-9, _ and -
const ADMIN_UID = ENV_ADMIN_UID // your numeric user id, e.g., "123456789"

const NOTIFY_INTERVAL = 3600 * 1000; // 1 hour
const fraudDb = 'https://raw.githubusercontent.com/LloydAsp/nfd/main/data/fraud.db';
const notificationUrl = 'https://raw.githubusercontent.com/LloydAsp/nfd/main/data/notification.txt'
const startMsgUrl = 'https://raw.githubusercontent.com/LloydAsp/nfd/main/data/startMessage.md';

const enable_notification = true

// === Captcha Settings ===
const CAPTCHA_ENABLED = true;
const CAPTCHA_TTL_SECONDS = 30 * 24 * 3600; // verified TTL: 30 days
const CAPTCHA_MAX_ATTEMPTS = 3;             // tries per challenge
const CAPTCHA_EXPIRE_SECONDS = 10 * 60;     // challenge TTL: 10 minutes

// ---- Telegram helpers ----
function apiUrl (methodName, params = null) {
  let query = ''
  if (params) {
    query = '?' + new URLSearchParams(params).toString()
  }
  return `https://api.telegram.org/bot${TOKEN}/${methodName}${query}`
}

function requestTelegram(methodName, body, params = null){
  return fetch(apiUrl(methodName, params), body).then(r => r.json())
}

function makeReqBody(body){
  return {
    method:'POST',
    headers:{
      'content-type':'application/json'
    },
    body:JSON.stringify(body)
  }
}

function sendMessage(msg = {}){
  return requestTelegram('sendMessage', makeReqBody(msg))
}

function forwardMessage(msg = {}){
  return requestTelegram('forwardMessage', makeReqBody(msg))
}

function copyMessage(msg = {}){
  return requestTelegram('copyMessage', makeReqBody(msg))
}

function setMyCommands(commands = []){
  return requestTelegram('setMyCommands', makeReqBody({commands}))
}

// ---- KV helpers ----
async function setKVJson(key, val, ttlSeconds = null) {
  const opts = {}
  if (ttlSeconds) opts.expirationTtl = ttlSeconds
  await nfd.put(key, JSON.stringify(val), opts)
}
async function getKVJson(key) {
  try {
    return await nfd.get(key, { type: "json" })
  } catch(e) {
    return null
  }
}

// ---- Captcha helpers ----
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}
function genCaptcha() {
  const a = randInt(1, 9)
  const b = randInt(1, 9)
  const op = Math.random() < 0.5 ? '+' : '-'
  let answer = op === '+' ? (a + b) : (a - b)
  if (answer <= 0) return genCaptcha() // ensure positive
  return { question: `${a} ${op} ${b} = ?`, answer }
}

async function sendCaptcha(chatId, forceNew = false) {
  const ansKey = `captcha-answer-${chatId}`
  const attKey = `captcha-attempts-${chatId}`

  let answerObj = await getKVJson(ansKey)
  let attempts = await getKVJson(attKey)

  if (forceNew || !answerObj) {
    const { question, answer } = genCaptcha()
    await setKVJson(ansKey, { answer }, CAPTCHA_EXPIRE_SECONDS)
    await setKVJson(attKey, { left: CAPTCHA_MAX_ATTEMPTS }, CAPTCHA_EXPIRE_SECONDS)
    return sendMessage({
      chat_id: chatId,
      text: `为了防止机器人滥用，请先通过简单算术验证：\n\n${question}\n\n请直接回复数字答案（例如：8）。`
    })
  }
  if (!attempts || typeof attempts.left !== 'number') {
    await setKVJson(attKey, { left: CAPTCHA_MAX_ATTEMPTS }, CAPTCHA_EXPIRE_SECONDS)
  }
  return sendMessage({
    chat_id: chatId,
    text: `请先完成当前算术验证再继续对话。\n（直接回复答案的数字即可；/captcha 可更换题目）`
  })
}

async function checkCaptchaAndMaybeVerify(message) {
  const chatId = message.chat.id
  const text = (message.text || '').trim()
  if (!text) {
    await sendCaptcha(chatId, false)
    return { verified: false }
  }
  if (/^\/captcha$/.test(text)) {
    await sendCaptcha(chatId, true)
    return { verified: false }
  }

  const ansKey = `captcha-answer-${chatId}`
  const attKey = `captcha-attempts-${chatId}`
  const answerObj = await getKVJson(ansKey)
  const attempts = await getKVJson(attKey)
  if (!answerObj) {
    await sendCaptcha(chatId, true)
    return { verified: false }
  }

  const numeric = Number(text)
  if (!Number.isFinite(numeric)) {
    await sendMessage({
      chat_id: chatId,
      text: `请直接回复一个数字作为答案（例如：8）。如需更换题目可发送 /captcha`
    })
    return { verified: false }
  }

  const left = attempts && typeof attempts.left === 'number' ? attempts.left : CAPTCHA_MAX_ATTEMPTS
  if (numeric === answerObj.answer) {
    await setKVJson(`verified-${chatId}`, true, CAPTCHA_TTL_SECONDS)
    // cleanup current puzzle (expire immediately)
    await setKVJson(ansKey, null, 1)
    await setKVJson(attKey, null, 1)
    await sendMessage({
      chat_id: chatId,
      text: `✅ 验证通过！在 ${Math.floor(CAPTCHA_TTL_SECONDS / (24*3600))} 天内你可直接与我对话。\n请重新发送你的消息。`
    })
    return { verified: true }
  } else {
    const remain = Math.max(0, left - 1)
    await setKVJson(attKey, { left: remain }, CAPTCHA_EXPIRE_SECONDS)
    if (remain <= 0) {
      await setKVJson(ansKey, null, 1)
      await setKVJson(attKey, null, 1)
      await sendMessage({
        chat_id: chatId,
        text: `❌ 回答错误，已无剩余尝试机会。我已为你生成新题，请再试一次。`
      })
      await sendCaptcha(chatId, true)
    } else {
      await sendMessage({
        chat_id: chatId,
        text: `❌ 回答错误，还剩 ${remain} 次机会。请再试一次，或发送 /captcha 更换题目。`
      })
    }
    return { verified: false }
  }
}

// ---- Worker routing ----
addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (url.pathname === WEBHOOK) {
    event.respondWith(handleWebhook(event))
  } else if (url.pathname === '/registerWebhook') {
    event.respondWith(registerWebhook(event, url, WEBHOOK, SECRET))
  } else if (url.pathname === '/unRegisterWebhook') {
    event.respondWith(unRegisterWebhook(event))
  } else {
    event.respondWith(new Response('No handler for this request'))
  }
})

async function handleWebhook (event) {
  if (event.request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== SECRET) {
    return new Response('Unauthorized', { status: 403 })
  }
  const update = await event.request.json()
  event.waitUntil(onUpdate(update))
  return new Response('Ok')
}

async function onUpdate (update) {
  try {
    if (update.message) {
      await onMessage(update.message)
    } else if (update.edited_message) {
      await onMessage(update.edited_message)
    }
  } catch (e) {
    console.log('onUpdate error:', e.stack || e)
  }
}

async function onMessage(message){
  // Normalize chat/user ids to string
  const fromId = message?.from?.id?.toString()
  const chatId = message?.chat?.id?.toString()

  if (!fromId || !chatId) return

  if (/^\/start$/.test(message.text || '')) {
    await handleStart(message)
    // prompt captcha for guests
    if (CAPTCHA_ENABLED && fromId !== ADMIN_UID) {
      const verified = await getKVJson('verified-' + chatId)
      if (!verified) await sendCaptcha(chatId, true)
    }
    return
  }

  // Admin flow (reply to guest)
  if (fromId === ADMIN_UID) {
    // admin commands
    if (/^\/block$/.test(message.text || '') && message.reply_to_message) return handleBlock(message)
    if (/^\/unblock$/.test(message.text || '') && message.reply_to_message) return handleUnBlock(message)
    if (/^\/checkblock$/.test(message.text || '') && message.reply_to_message) return checkBlock(message)

    // if admin replies to a forwarded message, copy back to the original guest
    if (message.reply_to_message) {
      let guestChantId = await getKVJson('msg-map-' + message.reply_to_message.message_id)
      return copyMessage({
        chat_id: guestChantId,
        from_chat_id: message.chat.id,
        message_id: message.message_id,
      })
    }
    // ignore other admin messages
    return
  }

  // Guest flow
  return handleGuestMessage(message)
}

async function handleGuestMessage(message){
  const chatId = message.chat.id.toString()

  // 1) Check block
  let isblocked = await getKVJson('isblocked-' + chatId)
  if (isblocked) {
    return sendMessage({ chat_id: chatId, text: 'You are blocked' })
  }

  // 2) Captcha gate
  if (CAPTCHA_ENABLED) {
    const verified = await getKVJson('verified-' + chatId)
    if (!verified) {
      const res = await checkCaptchaAndMaybeVerify(message)
      if (!res.verified) return // stop here; do not forward
    }
  }

  // 3) Forward to admin
  let forwardReq = await forwardMessage({
    chat_id: ADMIN_UID,
    from_chat_id: message.chat.id,
    message_id: message.message_id
  })
  if (forwardReq.ok) {
    await nfd.put('msg-map-' + forwardReq.result.message_id, chatId)
  }

  // 4) Optional notify text (rate limited)
  return handleNotify(message)
}

async function handleStart(message){
  try {
    const text = await fetch(startMsgUrl).then(r => r.text())
    await sendMessage({ chat_id: message.chat.id, text })
  } catch (_) {
    await sendMessage({ chat_id: message.chat.id, text: 'Hello!' })
  }
}

async function handleNotify(message){
  try{
    const {id} = message.chat
    let last_notify_time = await nfd.get('notify-last-' + id)
    const now = Date.now()
    if (enable_notification && (!last_notify_time || (now - Number(last_notify_time)) > NOTIFY_INTERVAL)) {
      let txt = await fetch(notificationUrl).then(r => r.text())
      await sendMessage({ chat_id: id, text: txt })
      await nfd.put('notify-last-' + id, now.toString())
    }
  } catch (e) {
    console.log('handleNotify error:', e.stack || e)
  }
}

// ---- Admin helpers ----
async function handleBlock(message){
  let guestChantId = await getKVJson('msg-map-' + message.reply_to_message.message_id)
  if (guestChantId == ADMIN_UID) {
    return sendMessage({ chat_id: ADMIN_UID, text: '不能屏蔽自己' })
  }
  await nfd.put('isblocked-' + guestChantId, JSON.stringify(true))
  return sendMessage({ chat_id: ADMIN_UID, text: `UID:${guestChantId} 屏蔽成功` })
}

async function handleUnBlock(message){
  let guestChantId = await getKVJson('msg-map-' + message.reply_to_message.message_id)
  await nfd.put('isblocked-' + guestChantId, JSON.stringify(false))
  return sendMessage({ chat_id: ADMIN_UID, text: `UID:${guestChantId} 已取消屏蔽` })
}

async function checkBlock(message){
  let guestChantId = await getKVJson('msg-map-' + message.reply_to_message.message_id)
  let isblocked = await getKVJson('isblocked-' + guestChantId)
  return sendMessage({ chat_id: ADMIN_UID, text: `UID:${guestChantId} 屏蔽状态：${isblocked ? '是' : '否'}` })
}

// ---- Webhook management ----
async function registerWebhook (event, url, path, secret) {
  const set = await (await fetch(apiUrl('setWebhook', {
    url: url.origin + path,
    secret_token: secret
  }))).json()
  // Optional: set simple commands for admin
  await setMyCommands([
    { command: 'block', description: '屏蔽（需引用要屏蔽用户的消息）' },
    { command: 'unblock', description: '取消屏蔽（需引用）' },
    { command: 'checkblock', description: '查询屏蔽状态（需引用）' },
    { command: 'captcha', description: '（访客）重新出一道算术题' },
  ])
  return new Response('ok' in set && set.ok ? 'Ok' : JSON.stringify(set, null, 2))
}

async function unRegisterWebhook (event) {
  const r = await (await fetch(apiUrl('setWebhook', { url: '' }))).json()
  return new Response('ok' in r && r.ok ? 'Ok' : JSON.stringify(r, null, 2))
}

// ---- Fraud DB (optional helper, not enforced here) ----
async function isFraud(id){
  id = id.toString()
  let db = await fetch(fraudDb).then(r => r.text())
  let arr = db.split('\n').filter(v => v)
  let flag = arr.includes(id)
  return flag
}
