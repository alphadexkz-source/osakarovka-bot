const wa        = require('../whatsapp/greenApi');
const db        = require('../db/index');
const q         = require('../db/queries');
const tariffEng = require('../modules/tariffEngine');
const driverMgr = require('../modules/driverManager');
const notify    = require('../modules/notificationService');
const config    = require('../config');

// ─── FIX: Защита от брутфорса PIN ─────────────────────────────
const login = async (phone, text) => {
  try {
    // Проверить блокировку
    const attempt = await q.checkAdminAttempt(phone);
    if (attempt.locked) {
      await wa.sendText(phone, `🔒 Слишком много попыток. Попробуйте через *${attempt.mins} мин*.`);
      return;
    }

    const pin = text.replace('/admin', '').trim();
    if (pin !== config.ADMIN_PIN) {
      const count = await q.recordFailedAdmin(phone);
      const left  = Math.max(0, 5 - count);
      await wa.sendText(phone, `❌ Неверный PIN.${left > 0 ? ` Осталось попыток: ${left}` : ' Аккаунт заблокирован на 15 мин.'}`);
      return;
    }

    // Успешный вход — сбросить счётчик
    await q.resetAdminAttempts(phone);

    const user = await q.getUser(phone);
    if (!user) await q.createUser(phone, 'Администратор', 'admin');
    else if (user.role !== 'admin') await q.updateUser(phone, { role: 'admin' });
    await q.setSession(phone, 'admin_mode', {});
    await q.setSetting('admin_phone', phone);
    await wa.sendText(phone, adminMenu());
  } catch (err) {
    console.error('[Admin login]', err.message);
  }
};

const adminMenu = () =>
  `👨‍💼 *Панель администратора*\n\n` +
  `📋 *Тарифы:* Тарифы | Добавить тариф | Изменить тариф | Удалить тариф\n\n` +
  `👥 *Водители:* Водители | Баланс +50 79001234567 | Блок водитель 79001234567\n\n` +
  `📊 *Статистика:* Статистика | Неделя | Месяц | Топ водителей\n\n` +
  `📢 *Рассылка:* Рассылка клиенты [текст] | Рассылка водители [текст]\n\n` +
  `🚫 *ЧС:* Блок 79001234567 | Разблок 79001234567\n\n` +
  `⚙️ *Режим:* Режим очередь | Режим первый\n\n` +
  `🎁 *Акции:* Акции | Реферал вкл/выкл | Лояльность вкл/выкл\n\n` +
  `*Выход* — выйти из панели`;

const handle = async (phone, msg, session) => {
  try {
    const { text } = msg;
    const state = session?.state || 'admin_mode';
    const ctx   = session?.ctx  || {};
    const lo    = (text || '').toLowerCase().trim();

    if (lo === 'выход') {
      await q.setSession(phone, 'admin_exit', {});
      await wa.sendText(phone, `👋 Вышли из панели.\n\nНапишите куда ехать 🚖 или На линию чтобы работать водителем.`);
      return;
    }

    if (state === 'admin_add_1') return addTariff_step1(phone, text, ctx);
    if (state === 'admin_add_2') return addTariff_step2(phone, text, ctx);
    if (state === 'admin_add_3') return addTariff_step3(phone, text, ctx);
    if (state === 'admin_add_4') return addTariff_step4(phone, text, ctx);
    if (state === 'admin_edit_pick')  return editTariff_pick(phone, text);
    if (state === 'admin_edit_field') return editTariff_field(phone, text, ctx);
    if (state === 'admin_del_pick')   return deleteTariff_pick(phone, text);

    // ── ТАРИФЫ ────────────────────────────────────────────────
    if (lo === 'тарифы') {
      const list = await q.getTariffs();
      await wa.sendText(phone, `📋 *Тарифы:*\n\n${tariffEng.formatTariffList(list)}`);
      return;
    }
    if (lo === 'добавить тариф') {
      await q.setSession(phone, 'admin_add_1', {});
      await wa.sendText(phone, '➕ *Добавление тарифа*\n\nШаг 1/4: *Название* направления:');
      return;
    }
    if (lo === 'изменить тариф') {
      const list = await q.getTariffs();
      if (!list.length) { await wa.sendText(phone, '❌ Тарифов нет.'); return; }
      await q.setSession(phone, 'admin_edit_pick', {});
      await wa.sendText(phone, `✏️ Введите *номер* тарифа:\n\n${tariffEng.formatTariffList(list)}`);
      return;
    }
    if (lo === 'удалить тариф') {
      const list = await q.getTariffs();
      if (!list.length) { await wa.sendText(phone, '❌ Тарифов нет.'); return; }
      await q.setSession(phone, 'admin_del_pick', {});
      await wa.sendText(phone, `🗑 Введите *номер* тарифа:\n\n${tariffEng.formatTariffList(list)}`);
      return;
    }

    // ── ВОДИТЕЛИ ──────────────────────────────────────────────
    if (lo === 'водители') {
      const list   = await q.getAllDrivers();
      const online = list.filter(d => ['online','busy'].includes(d.status)).length;
      await wa.sendText(phone, `👥 *Водители (${online} онлайн из ${list.length}):*\n\n${driverMgr.formatList(list)}`);
      return;
    }
    if (lo.startsWith('баланс')) {
      const parts  = text.trim().split(/\s+/);
      const amount = parseInt((parts[1] || '').replace('+', ''));
      const target = (parts[2] || '').replace(/\D/g, '');
      if (isNaN(amount) || amount <= 0 || !target) {
        await wa.sendText(phone, '❌ Формат: *Баланс +50 79001234567*');
        return;
      }
      // FIX: ограничим максимум пополнения
      if (amount > 10000) { await wa.sendText(phone, '❌ Максимум 10000 за раз.'); return; }
      const result = await q.addDriverBalance(target, amount);
      if (!result) { await wa.sendText(phone, `❌ Водитель ${target} не найден.`); return; }
      await q.addBillingRecord(result.id, amount, result.order_balance, 'Пополнение', phone);
      await wa.sendText(phone, `✅ ${target} — пополнено *+${amount}*. Итого: *${result.order_balance}*`);
      await wa.sendText(target, `📦 Баланс пополнен!\n➕ *+${amount} заказов*\nТекущий: *${result.order_balance}*`);
      return;
    }
    if (lo.startsWith('блок водитель')) {
      const target = text.split(/\s+/).pop().replace(/\D/g, '');
      await q.blacklistDriver(target, true);
      await wa.sendText(phone, `🚫 Водитель ${target} заблокирован.`);
      await wa.sendText(target, '🚫 Ваш аккаунт заблокирован. Обратитесь к администратору.').catch(() => {});
      return;
    }
    if (lo.startsWith('разблок водитель')) {
      const target = text.split(/\s+/).pop().replace(/\D/g, '');
      await q.blacklistDriver(target, false);
      await wa.sendText(phone, `✅ Водитель ${target} разблокирован.`);
      return;
    }

    // ── СТАТИСТИКА ────────────────────────────────────────────
    if (lo === 'статистика') {
      const s = await q.getTodayStats();
      const d = await q.getAllDrivers();
      const online = d.filter(x => ['online','busy'].includes(x.status)).length;
      // Реферальная статистика
      const refStats = await db.query(
        `SELECT COUNT(*) FILTER(WHERE status='activated') AS activated,
                COUNT(*) FILTER(WHERE status='pending') AS pending
         FROM referrals`
      ).catch(()=>({rows:[{activated:0,pending:0}]}));
      const ref = refStats.rows[0];
      await wa.sendText(phone,
        `📊 *Сегодня:*

🚖 Выполнено: *${s.completed}*
❌ Отменено: *${s.cancelled}*
📦 Всего: *${s.total}*
💰 Оборот: *${Number(s.revenue).toLocaleString()} тг*

👥 Онлайн: *${online}/${d.length}*

🎁 Рефералов всего: *${parseInt(ref.activated)+parseInt(ref.pending)}* (активных: *${ref.activated}*)`
      );
      return;
    }
    if (lo === 'неделя') {
      const s = await q.getPeriodStats(7);
      await wa.sendText(phone, `📊 *За 7 дней:*\n\n🚖 Выполнено: *${s.completed}*\n❌ Отменено: *${s.cancelled}*\n💰 Оборот: *${Number(s.revenue).toLocaleString()} тг*\n👤 Клиентов: *${s.unique_clients}*`);
      return;
    }
    if (lo === 'месяц') {
      const s = await q.getPeriodStats(30);
      await wa.sendText(phone, `📊 *За 30 дней:*\n\n🚖 Выполнено: *${s.completed}*\n❌ Отменено: *${s.cancelled}*\n💰 Оборот: *${Number(s.revenue).toLocaleString()} тг*\n👤 Клиентов: *${s.unique_clients}*`);
      return;
    }
    if (lo === 'топ водителей') {
      const top   = await q.getTopDrivers(7);
      const lines = top.map((d,i) => `*${i+1}.* ${d.full_name} — ${d.trips} поезд. | ⭐${Number(d.avg_rating||5).toFixed(1)}`).join('\n');
      await wa.sendText(phone, `🏆 *Топ водителей (7 дней):*\n\n${lines || 'Данных нет'}`);
      return;
    }

    // ── РАССЫЛКИ ──────────────────────────────────────────────
    if (lo.startsWith('рассылка клиенты ') || lo.startsWith('рассылки клиенты ')) {
      const m = text.slice('рассылка клиенты '.length).trim();
      if (!m) { await wa.sendText(phone, '❌ Укажите текст.'); return; }
      const n = await notify.broadcast('client', m);
      await wa.sendText(phone, `✅ Отправлено *${n}* клиентам.`);
      return;
    }
    if (lo.startsWith('рассылка водители ') || lo.startsWith('рассылки водители ')) {
      const m = text.slice('рассылка водители '.length).trim();
      if (!m) { await wa.sendText(phone, '❌ Укажите текст.'); return; }
      const n = await notify.broadcast('driver', m);
      await wa.sendText(phone, `✅ Отправлено *${n}* водителям.`);
      return;
    }

    // ── ЧС ────────────────────────────────────────────────────
    if (lo.startsWith('блок ') && !lo.includes('водитель')) {
      const target = text.split(' ')[1]?.replace(/\D/g, '');
      if (!target) { await wa.sendText(phone, '❌ Укажите номер.'); return; }
      await q.blacklistUser(target, true);
      await wa.sendText(phone, `🚫 ${target} заблокирован.`);
      return;
    }
    if (lo.startsWith('разблок ') && !lo.includes('водитель')) {
      const target = text.split(' ')[1]?.replace(/\D/g, '');
      if (!target) { await wa.sendText(phone, '❌ Укажите номер.'); return; }
      await q.blacklistUser(target, false);
      await wa.sendText(phone, `✅ ${target} разблокирован.`);
      return;
    }

    // ── РЕЖИМ ─────────────────────────────────────────────────
    if (lo === 'режим очередь') { await q.setSetting('distribution_mode','queue'); await wa.sendText(phone,'✅ Режим: *Строгая очередь*'); return; }
    if (lo === 'режим первый')  { await q.setSetting('distribution_mode','first'); await wa.sendText(phone,'✅ Режим: *Кто первый принял*'); return; }

    // ── ПРОГРАММЫ ЛОЯЛЬНОСТИ ──────────────────────────────────
    if (lo === 'акции') {
      const [refEnabled, refBonus, loyEnabled, loyEvery, loyBonus] = await Promise.all([
        q.getSetting('referral_enabled'),
        q.getSetting('referral_bonus'),
        q.getSetting('loyalty_enabled'),
        q.getSetting('loyalty_every'),
        q.getSetting('loyalty_bonus'),
      ]);
      const refStatus = refEnabled !== 'false' ? '🟢 Включена' : '🔴 Выключена';
      const loyStatus = loyEnabled !== 'false' ? '🟢 Включена' : '🔴 Выключена';
      await wa.sendText(phone,
        `🎁 *Статус программ:*

` +
        `*Реферальная программа:* ${refStatus}
` +
        `  • Бонус рефереру: *${refBonus || 1} поездка*
` +
        `  • Условие: друг должен завершить 1-ю поездку

` +
        `*Программа лояльности:* ${loyStatus}
` +
        `  • Каждая *${loyEvery || 10}-я* поездка бесплатная
` +
        `  • Бонус: *${loyBonus || 1} поездка*

` +
        `Команды:
` +
        `• *Реферал вкл/выкл*
` +
        `• *Реферал бонус 2* — задать кол-во бонусных поездок
` +
        `• *Лояльность вкл/выкл*
` +
        `• *Лояльность каждые 5* — каждая 5-я бесплатная`
      );
      return;
    }
    if (lo === 'реферал вкл') {
      await q.setSetting('referral_enabled', 'true');
      await wa.sendText(phone, '✅ Реферальная программа *включена*.');
      return;
    }
    if (lo === 'реферал выкл') {
      await q.setSetting('referral_enabled', 'false');
      await wa.sendText(phone, `🔴 Реферальная программа *выключена*.\n\nНакопленные бонусы у клиентов сохраняются, но не начисляются новые.`);
      return;
    }
    if (lo.startsWith('реферал бонус ')) {
      const n = parseInt(text.split(' ')[2]);
      if (isNaN(n) || n < 1 || n > 10) { await wa.sendText(phone, `❌ Укажи число от 1 до 10.\nПример: *Реферал бонус 2*`); return; }
      await q.setSetting('referral_bonus', String(n));
      await wa.sendText(phone, `✅ Бонус рефереру: *${n} поездка*.\n\nНовые рефералы получат обновлённый бонус.`);
      return;
    }
    if (lo === 'лояльность вкл') {
      await q.setSetting('loyalty_enabled', 'true');
      await wa.sendText(phone, '✅ Программа лояльности *включена*.');
      return;
    }
    if (lo === 'лояльность выкл') {
      await q.setSetting('loyalty_enabled', 'false');
      await wa.sendText(phone, `🔴 Программа лояльности *выключена*.\n\nСчётчик поездок у клиентов сохраняется.`);
      return;
    }
    if (lo.startsWith('лояльность каждые ')) {
      const n = parseInt(text.split(' ')[2]);
      if (isNaN(n) || n < 2 || n > 100) { await wa.sendText(phone, `❌ Укажи число от 2 до 100.\nПример: *Лояльность каждые 5*`); return; }
      await q.setSetting('loyalty_every', String(n));
      await wa.sendText(phone, `✅ Каждая *${n}-я* поездка теперь бесплатная.`);
      return;
    }
    await wa.sendText(phone, adminMenu());
  } catch (err) {
    console.error('[Admin handle]', err.message);
    await wa.sendText(phone, '❌ Произошла ошибка. Попробуйте ещё раз.').catch(() => {});
  }
};

const addTariff_step1 = async (p,t,ctx) => {
  if ((t||'').toLowerCase().trim()==='отмена') { await q.setSession(p,'admin_mode',{}); await wa.sendText(p,'↩️ Отменено.'); return; }
  if (!t?.trim()) { await wa.sendText(p,'❌ Введите название:'); return; }
  await q.setSession(p,'admin_add_2',{...ctx,name:t.trim().slice(0,100)});
  await wa.sendText(p,`✅ Название: *${t.trim()}*\n\nШаг 2/4: Цена *днём* (тг):`);
};
const addTariff_step2 = async (p,t,ctx) => {
  if ((t||'').toLowerCase().trim()==='отмена') { await q.setSession(p,'admin_mode',{}); await wa.sendText(p,'↩️ Отменено.'); return; }
  const dp=parseInt(t);
  if (isNaN(dp)||dp<=0||dp>99999) { await wa.sendText(p,'❌ Введите число от 1 до 99999:'); return; }
  await q.setSession(p,'admin_add_3',{...ctx,day_price:dp});
  await wa.sendText(p,`✅ День: *${dp} тг*\n\nШаг 3/4: Цена *ночью* (или 0 = как днём):`);
};
const addTariff_step3 = async (p,t,ctx) => {
  if ((t||'').toLowerCase().trim()==='отмена') { await q.setSession(p,'admin_mode',{}); await wa.sendText(p,'↩️ Отменено.'); return; }
  const np=parseInt(t)||0;
  await q.setSession(p,'admin_add_4',{...ctx,night_price:np>0?np:null});
  await wa.sendText(p,`✅ Ночь: *${np>0?np+' тг':'как днём'}*\n\nШаг 4/4: *Ключевые слова* через запятую:`);
};
const addTariff_step4 = async (p,t,ctx) => {
  if ((t||'').toLowerCase().trim()==='отмена') { await q.setSession(p,'admin_mode',{}); await wa.sendText(p,'↩️ Отменено.'); return; }
  const kw=t.split(',').map(k=>k.trim().toLowerCase().slice(0,50)).filter(Boolean).slice(0,20);
  if (!kw.length) { await wa.sendText(p,'❌ Введите хотя бы одно ключевое слово:'); return; }
  const tariff = await q.createTariff({name:ctx.name,keywords:kw,day_price:ctx.day_price,night_price:ctx.night_price});
  await q.setSession(p,'admin_mode',{});
  await wa.sendText(p,`✅ *Тариф добавлен!*\n📍 ${tariff.name}\n💰 День: ${tariff.day_price} тг${tariff.night_price?` | Ночь: ${tariff.night_price} тг`:''}\n🔑 ${kw.join(', ')}`);
};

const editTariff_pick = async (p,t) => {
  const list=await q.getTariffs();
  const n=parseInt(t);
  if (isNaN(n)||n<1||n>list.length) { await wa.sendText(p,`❌ Номер от 1 до ${list.length}:`); return; }
  const tariff=list[n-1];
  await q.setSession(p,'admin_edit_field',{tariff_id:tariff.id});
  await wa.sendText(p,`✏️ *${tariff.name}*\n\n• *название* Новое\n• *цена день* 600\n• *цена ночь* 800\n• *ключи* слово1, слово2\n• *отмена*`);
};
const editTariff_field = async (p,t,ctx) => {
  const lo=t.toLowerCase();
  if (lo==='отмена') { await q.setSession(p,'admin_mode',{}); await wa.sendText(p,'↩️ Отменено.'); return; }
  let upd={};
  if (lo.startsWith('название '))   upd.name=t.slice(9).trim().slice(0,100);
  else if (lo.startsWith('цена день '))  upd.day_price=parseInt(t.slice(10));
  else if (lo.startsWith('цена ночь ')) upd.night_price=parseInt(t.slice(10));
  else if (lo.startsWith('ключи '))   upd.keywords=t.slice(6).split(',').map(k=>k.trim().toLowerCase().slice(0,50)).filter(Boolean);
  else { await wa.sendText(p,'❌ Неизвестно. Попробуй ещё или *отмена*:'); return; }

  // Валидация чисел
  if (upd.day_price !== undefined && (isNaN(upd.day_price)||upd.day_price<=0)) { await wa.sendText(p,'❌ Введите корректное число:'); return; }
  if (upd.night_price !== undefined && (isNaN(upd.night_price)||upd.night_price<0)) { await wa.sendText(p,'❌ Введите корректное число:'); return; }

  await q.updateTariff(ctx.tariff_id, upd);
  await q.setSession(p,'admin_mode',{});
  await wa.sendText(p,'✅ Тариф обновлён!');
};
const deleteTariff_pick = async (p,t) => {
  if (t.toLowerCase()==='отмена') { await q.setSession(p,'admin_mode',{}); await wa.sendText(p,'↩️ Отменено.'); return; }
  const list=await q.getTariffs();
  const n=parseInt(t);
  if (isNaN(n)||n<1||n>list.length) { await wa.sendText(p,`❌ Номер от 1 до ${list.length} или *отмена*:`); return; }
  const tariff=list[n-1];
  await q.deleteTariff(tariff.id);
  await q.setSession(p,'admin_mode',{});
  await wa.sendText(p,`🗑 Тариф *${tariff.name}* удалён.`);
};

module.exports = { login, handle };
