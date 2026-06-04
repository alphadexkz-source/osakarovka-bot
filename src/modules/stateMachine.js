'use strict'

/**
 * stateMachine.js — Централизованное управление FSM-состояниями бота.
 *
 * Назначение:
 *   - Единый реестр всех допустимых состояний
 *   - Валидация переходов с логированием нарушений
 *   - Удобные хелперы transition/reset для новых фич
 *
 * Важно: не блокирует невалидные переходы — только логирует.
 * Существующие q.setSession() вызовы продолжают работать без изменений.
 * stateMachine — дополнительный слой, не замена.
 */

const q   = require('../db/queries')
const log = require('../logger')

// ─── Все допустимые состояния ─────────────────────────────────

const VALID_STATES = new Set([
  // Клиент
  'idle',                 // ожидание нового заказа
  'confirming',           // клиент видит цену и подтверждает заказ
  'waiting_driver',       // заказ создан, ищем водителя
  'in_trip',              // водитель принят, едет к клиенту
  'chat_mode',            // анонимный чат с водителем
  'waiting_rating',       // запрос оценки после поездки
  'cancel_client_reason', // клиент выбирает причину отмены
  'intercity_pickup',     // межгород: ввод адреса подачи
  'intercity_time',       // межгород: ввод времени
  'intercity_confirm',    // межгород: подтверждение
  'schedule_time',        // предзаказ: ввод времени
  'scheduled_confirm',    // предзаказ: подтверждение
  'scheduled',            // предзаказ: ожидание наступления времени

  // Водитель
  'driver_as_client', // водитель заказывает такси для себя
  'driver_chat',      // водитель в чате с клиентом
  'cancel_reason',    // водитель выбирает причину отмены
  'reg_name',         // регистрация шаг 1: ФИО
  'reg_photo',        // регистрация шаг 2: фото авто
  'reg_make',         // регистрация шаг 3: марка/модель
  'reg_plate',        // регистрация шаг 4: гос. номер
  'reg_color',        // регистрация шаг 5: цвет
  'edit_name',        // редактирование: ФИО
  'edit_car',         // редактирование: авто (марка + номер)
  'edit_photo',       // редактирование: фото
  'edit_color',       // редактирование: цвет

  // Админ
  'admin_mode',       // главное меню администратора
  'admin_add_1',      // добавление тарифа: шаг 1 (название)
  'admin_add_2',      // добавление тарифа: шаг 2 (цена день)
  'admin_add_3',      // добавление тарифа: шаг 3 (цена ночь)
  'admin_add_4',      // добавление тарифа: шаг 4 (ключевые слова)
  'admin_edit_pick',  // редактирование тарифа: выбор
  'admin_edit_field', // редактирование тарифа: поле
  'admin_del_pick',   // удаление тарифа: выбор
  'admin_exit',       // выход из панели (перед сбросом в idle)
])

// ─── Допустимые переходы ──────────────────────────────────────
// Используются только для логирования нарушений (не блокируют).
// Неперечисленные переходы логируются как warning.

const ALLOWED_TRANSITIONS = {
  'idle':                 ['confirming', 'waiting_driver', 'chat_mode', 'intercity_pickup',
                           'driver_as_client', 'reg_name', 'admin_mode', 'waiting_rating'],
  'confirming':           ['waiting_driver', 'idle'],
  'waiting_driver':       ['in_trip', 'idle', 'cancel_client_reason'],
  'in_trip':              ['idle', 'chat_mode'],
  'chat_mode':            ['idle', 'in_trip'],
  'waiting_rating':       ['idle'],
  'cancel_client_reason': ['idle'],
  'intercity_pickup':     ['intercity_time', 'idle'],
  'intercity_time':       ['intercity_confirm', 'idle'],
  'intercity_confirm':    ['waiting_driver', 'idle'],
  'confirming':           ['waiting_driver', 'idle', 'schedule_time', 'scheduled_confirm'],
  'schedule_time':        ['scheduled_confirm', 'confirming', 'idle'],
  'scheduled_confirm':    ['scheduled', 'idle'],
  'scheduled':            ['waiting_driver', 'idle'],
}

// ─── Хелперы ──────────────────────────────────────────────────

/**
 * Проверяет допустимость перехода между состояниями.
 * Возвращает true если переход валиден по ALLOWED_TRANSITIONS.
 * Переходы в idle, reg_*, edit_*, admin_* всегда считаются валидными.
 */
const isValidTransition = (from, to) => {
  if (to === 'idle') return true
  if (to.startsWith('reg_') || to.startsWith('edit_') || to.startsWith('admin_')) return true
  const allowed = ALLOWED_TRANSITIONS[from] || []
  return allowed.includes(to)
}

/**
 * Выполняет переход состояния с валидацией и логированием.
 * При невалидном переходе — только warn, не бросает ошибку.
 *
 * @param {string} phone     - Телефон пользователя
 * @param {string} newState  - Целевое состояние из VALID_STATES
 * @param {object} ctx       - Контекст сессии (данные шага)
 * @returns {{ from: string, to: string }}
 */
const transition = async (phone, newState, ctx = {}) => {
  if (!VALID_STATES.has(newState)) {
    log.warn('stateMachine', 'unknown_state', { phone, state: newState })
  }

  const session  = await q.getSession(phone)
  const fromState = session?.state || 'idle'

  if (!isValidTransition(fromState, newState)) {
    log.warn('stateMachine', 'invalid_transition', { phone, from: fromState, to: newState })
  }

  await q.setSession(phone, newState, ctx)
  log.driver(phone, 'transition', { from: fromState, to: newState })
  return { from: fromState, to: newState }
}

/**
 * Возвращает текущее состояние (state) из сессии.
 * Возвращает 'idle' если сессии нет.
 */
const getCurrentState = async (phone) => {
  const session = await q.getSession(phone)
  return session?.state || 'idle'
}

/**
 * Сбрасывает состояние пользователя в idle с пустым контекстом.
 * Эквивалентно q.clearSession(), но логирует переход.
 */
const reset = async (phone) => transition(phone, 'idle', {})

module.exports = {
  transition,
  getCurrentState,
  isValidTransition,
  reset,
  VALID_STATES,
  ALLOWED_TRANSITIONS,
}
