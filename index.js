require('dotenv').config();

const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const connectDB = require('./config/db');
const History = require('./models/History');
const fiveSim = require('./services/fiveSim');

const ADMIN_ID = Number(process.env.ADMIN_ID);
const POLL_INTERVAL_MS = 4000;      // فحص كل 4 ثوانٍ
const ORDER_TIMEOUT_MS = 2 * 60 * 1000; // مهلة دقيقتين

// ===================== Express (Render Health Check) =====================
const app = express();
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Health server on port ${PORT}`));

// ===================== DB =====================
connectDB();

// ===================== Bot =====================
const bot = new Telegraf(process.env.BOT_TOKEN);

// ---------- Middleware: حظر أي شخص غير المالك ----------
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  if (userId !== ADMIN_ID) return; // تجاهل تام — لا رد ولا تنفيذ
  return next();
});

// ---------- حالة مؤقتة في الذاكرة ----------
const userState = new Map(); // adminId -> { awaitingServiceText?: boolean }
const activePollers = new Map(); // orderId -> intervalId

// ---------- قوائم ----------
const mainKeyboard = () =>
  Markup.keyboard([['💰 رصيدي في 5SIM'], ['📱 شراء رقم جديد'], ['📜 سجل المشتريات']])
    .resize()
    .persistent();

const servicesKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('🟢 WhatsApp', 'svc:whatsapp'), Markup.button.callback('✈️ Telegram', 'svc:telegram')],
    [Markup.button.callback('🔍 Google', 'svc:google'), Markup.button.callback('📘 Facebook', 'svc:facebook')],
    [Markup.button.callback('🐦 Twitter', 'svc:twitter'), Markup.button.callback('🎵 TikTok', 'svc:tiktok')],
    [Markup.button.callback('✍️ خدمة أخرى (اكتب الاسم)', 'svc:custom')],
  ]);

const backKeyboard = () =>
  Markup.inlineKeyboard([[Markup.button.callback('🔙 القائمة الرئيسية', 'menu:main')]]);

const orderKeyboard = (orderId) =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback('❌ إلغاء واسترداد الرصيد', `cancel:${orderId}`),
      Markup.button.callback('🚫 الرقم محظور (Ban)', `ban:${orderId}`),
    ],
  ]);

// ---------- أوامر ----------
bot.start(async (ctx) => {
  await ctx.reply(
    '👋 أهلاً بك في بوت الأرقام الشخصي الخاص بك.\nاختر من القائمة بالأسفل:',
    mainKeyboard()
  );
});

bot.hears('💰 رصيدي في 5SIM', async (ctx) => {
  try {
    const profile = await fiveSim.getProfile();
    await ctx.reply(
      `💰 <b>رصيدك الحالي في 5SIM:</b> <code>$${Number(profile.balance).toFixed(2)}</code>\n` +
        `📧 الحساب: <code>${profile.email || '—'}</code>`,
      { parse_mode: 'HTML' }
    );
  } catch (err) {
    await ctx.reply('⚠️ تعذر جلب الرصيد. تأكد من صحة FIVE_SIM_TOKEN.', backKeyboard());
  }
});

bot.hears('📱 شراء رقم جديد', async (ctx) => {
  await ctx.reply('📱 اختر التطبيق المطلوب:', servicesKeyboard());
});

bot.hears('📜 سجل المشتريات', async (ctx) => {
  try {
    const items = await History.find().sort({ createdAt: -1 }).limit(10).lean();
    if (!items.length) return ctx.reply('📜 لا توجد عمليات مسجلة بعد.', mainKeyboard());
    const lines = items.map(
      (h, i) =>
        `${i + 1}. <code>${h.phone}</code> | ${h.service} | ${h.country} | $${h.price}\n` +
        `   الكود: <code>${h.code || '—'}</code> | الحالة: ${h.status} | ${new Date(h.createdAt).toLocaleString('ar-EG')}`
    );
    await ctx.reply(`📜 <b>آخر ${items.length} عمليات:</b>\n\n${lines.join('\n\n')}`, {
      parse_mode: 'HTML',
    });
  } catch {
    await ctx.reply('⚠️ تعذر جلب السجل من قاعدة البيانات.');
  }
});

// ---------- اختيار خدمة ----------
bot.action(/^svc:(.+)$/, async (ctx) => {
  const service = ctx.match[1];
  await ctx.answerCbQuery();

  if (service === 'custom') {
    userState.set(ctx.from.id, { awaitingServiceText: true });
    return ctx.reply('✍️ أرسل اسم الخدمة بالإنجليزية كما هو في 5SIM (مثال: instagram):', backKeyboard());
  }

  await showOffers(ctx, service);
});

// ---------- استقبال اسم خدمة كنص ----------
bot.on('text', async (ctx) => {
  const state = userState.get(ctx.from.id);
  if (!state?.awaitingServiceText) return; // أي نص آخر يُتجاهل
  userState.delete(ctx.from.id);
  const service = ctx.message.text.trim().toLowerCase();
  await showOffers(ctx, service);
});

async function showOffers(ctx, service) {
  const loading = await ctx.reply(`⏳ جاري البحث عن أفضل عروض <b>${service}</b> ...`, { parse_mode: 'HTML' });
  try {
    const offers = await fiveSim.getBestOffers(service, 8);
    if (!offers.length) {
      return ctx.telegram.editMessageText(
        ctx.chat.id,
        loading.message_id,
        undefined,
        `😕 لا توجد عروض متاحة لـ <b>${service}</b> حالياً\n(تم استبعاد المخزون الصفري ونسب الوصول الأقل من 40%).`,
        { parse_mode: 'HTML', ...backKeyboard() }
      );
    }

    const rows = offers.map((o) => [
      Markup.button.callback(
        `${o.country} | $${o.cost} | ${o.rate}% | 📦 ${o.count}`,
        `buy:${service}:${o.country}:${o.operator}:${o.cost}`
      ),
    ]);
    rows.push([Markup.button.callback('🔙 القائمة الرئيسية', 'menu:main')]);

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loading.message_id,
      undefined,
      `💡 <b>أفضل ${offers.length} عروض لـ ${service}</b> (الأرخص أولاً):\nالدولة | السعر | نسبة الوصول | المخزون`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) }
    );
  } catch (err) {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loading.message_id,
      undefined,
      `⚠️ حدث خطأ أثناء جلب الأسعار: ${err.message}`,
      backKeyboard()
    );
  }
}

// ---------- تنفيذ الشراء ----------
bot.action(/^buy:([^:]+):([^:]+):([^:]+):(.+)$/, async (ctx) => {
  const [, service, country, operator, cost] = ctx.match;
  await ctx.answerCbQuery('⏳ جاري شراء الرقم...');

  try {
    const order = await fiveSim.buyActivation(country, operator, service);

    // حفظ في السجل
    try {
      await History.create({
        orderId: order.id,
        phone: order.phone,
        country,
        operator,
        service,
        price: Number(cost) || order.price,
        status: 'PENDING',
      });
    } catch (e) {
      console.error('History save error:', e.message);
    }

    // الرقم في نص منفصل لسهولة النسخ بنقرة واحدة
    await ctx.reply(
      `✅ <b>تم شراء الرقم بنجاح!</b>\n\n📱 الرقم (اضغط للنسخ):\n<code>${order.phone}</code>\n\n` +
        `🌍 الدولة: ${country}\n🛠 المشغل: ${operator}\n📦 الخدمة: ${service}\n💵 السعر: $${cost}\n🆔 الطلب: ${order.id}\n\n` +
        `⏳ جاري انتظار كود التفعيل... (مهلة دقيقتين كحد أقصى)`,
      { parse_mode: 'HTML', ...orderKeyboard(order.id) }
    );

    startPolling(ctx, order.id);
  } catch (err) {
    const apiMsg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    await ctx.reply(`⚠️ فشل الشراء: ${apiMsg}`, backKeyboard());
  }
});

// ---------- حلقة الفحص التلقائي (Live Polling) ----------
function startPolling(ctx, orderId) {
  stopPolling(orderId);
  const startedAt = Date.now();

  const intervalId = setInterval(async () => {
    try {
      const data = await fiveSim.checkOrder(orderId);

      // وصول الكود
      if (data.status === 'RECEIVED' && Array.isArray(data.sms) && data.sms.length) {
        const code = data.sms[0].code || data.sms[0].text;
        stopPolling(orderId);

        await ctx.reply(
          `🔔 <b>وصل الكود!</b>\n\n🔑 الكود (اضغط للنسخ):\n<code>${code}</code>\n\n` +
            `📱 الرقم: <code>${data.phone}</code>`,
          { parse_mode: 'HTML' }
        );

        try {
          await fiveSim.finishOrder(orderId);
          await History.updateOne({ orderId }, { status: 'FINISHED', code: String(code) });
          await ctx.reply('✅ تم إنهاء الطلب بنجاح. استمتع! 🎉', mainKeyboard());
        } catch (e) {
          await History.updateOne({ orderId }, { status: 'RECEIVED', code: String(code) });
          await ctx.reply('⚠️ وصل الكود لكن تعذر إنهاء الطلب تلقائياً — أنهِه يدوياً من حسابك في 5SIM.');
        }
        return;
      }

      // انتهاء المهلة (دقيقتان)
      if (Date.now() - startedAt >= ORDER_TIMEOUT_MS) {
        stopPolling(orderId);
        try {
          await fiveSim.cancelOrder(orderId);
          await History.updateOne({ orderId }, { status: 'TIMEOUT' });
          await ctx.reply(
            `⏰ انتهت مهلة الدقيقتين دون وصول كود.\n❌ تم إلغاء الرقم <code>${data.phone || ''}</code> تلقائياً واسترداد الرصيد.`,
            { parse_mode: 'HTML', ...mainKeyboard() }
          );
        } catch (e) {
          await ctx.reply('⚠️ انتهت المهلة لكن تعذر الإلغاء التلقائي — ألغِ الطلب يدوياً من حسابك.');
        }
        return;
      }

      // لو الطلب أُلغي/انتهى من جهة 5SIM
      if (['CANCELED', 'FINISHED', 'BANNED'].includes(data.status)) {
        stopPolling(orderId);
        await History.updateOne({ orderId }, { status: data.status });
      }
    } catch (err) {
      console.error(`Polling error for order ${orderId}:`, err.message);
    }
  }, POLL_INTERVAL_MS);

  activePollers.set(orderId, intervalId);
}

function stopPolling(orderId) {
  const id = activePollers.get(orderId);
  if (id) {
    clearInterval(id);
    activePollers.delete(orderId);
  }
}

// ---------- إلغاء يدوي ----------
bot.action(/^cancel:(\d+)$/, async (ctx) => {
  const orderId = Number(ctx.match[1]);
  await ctx.answerCbQuery('⏳ جاري الإلغاء...');
  stopPolling(orderId);
  try {
    await fiveSim.cancelOrder(orderId);
    await History.updateOne({ orderId }, { status: 'CANCELED' });
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    await ctx.reply(`❌ تم إلغاء الطلب <code>${orderId}</code> واسترداد الرصيد إلى حسابك في 5SIM.`, {
      parse_mode: 'HTML',
      ...mainKeyboard(),
    });
  } catch (err) {
    await ctx.reply(`⚠️ تعذر الإلغاء: ${err.response?.data ? JSON.stringify(err.response.data) : err.message}`);
  }
});

// ---------- تبليغ حظر ----------
bot.action(/^ban:(\d+)$/, async (ctx) => {
  const orderId = Number(ctx.match[1]);
  await ctx.answerCbQuery('⏳ جاري تسجيل الحظر...');
  stopPolling(orderId);
  try {
    await fiveSim.banOrder(orderId);
    await History.updateOne({ orderId }, { status: 'BANNED' });
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    await ctx.reply(`🚫 تم تسجيل الرقم كمحظور للطلب <code>${orderId}</code>.`, {
      parse_mode: 'HTML',
      ...mainKeyboard(),
    });
  } catch (err) {
    await ctx.reply(`⚠️ تعذر تنفيذ الحظر: ${err.response?.data ? JSON.stringify(err.response.data) : err.message}`);
  }
});

// ---------- رجوع للقائمة ----------
bot.action('menu:main', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('🏠 القائمة الرئيسية:', mainKeyboard());
});

// ---------- تشغيل ----------
bot.launch().then(() => console.log('🤖 Bot is running...'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
