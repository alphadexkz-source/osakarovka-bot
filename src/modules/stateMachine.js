'use strict'
const q = require('../db/queries')
const log = require('../logger')

// Все допустимые состояния
const VALID_STATES = new Set([
  // Клиент
  'idle', 'confirming', 'waiting_driver', 'in_trip', 'chat_mode',
  'waiting_rating', 'cancel_client_reason',
  'intercity_pickup', 'intercity_time', 'intercity_confirm',
  // Водитель
  'driver_as_client', 'driver_chat', 'cancel_reason',
  'reg_name', 'reg_photo', 'reg_make', 'reg_plate', 'reg_color', 'reg_referral',
  'edit_name', 'edit_car', 'edit_photo', 'edit_color',
  // Админ
  'admin_mode', 'admin_add_1', 'admin_add_2', 'admin_add_3', 'admin_add_4',
  'admin_edit_pick', 'admin_edit_field', 'admin_del_pick', 'admin_exit',
])

// Допустимые переходы (не блокируют, только логируют нарушения)
const ALLOWED_TRANSITIONS = {
  'idle': ['confirming', 'waiting_driver', 'chat_mode', 'intercity_pickup',
           'driver_as_client', 'reg_name', 'admin_mode', 'waiting_rating'],
  'confirming': ['waiting_driver', 'idle'],
  'waiting_driver': ['in_trip', 'idle', 'cancel_client_reason'],
  'in_trip': ['idle', 'chat_mode'],
  'chat_mode': ['idle', 'in_trip'],
  'waiting_rating': ['idle'],
  'cancel_client_reason': ['idle'],
  'intercity_pickup': ['intercity_time', 'idle'],
  'intercity_time': ['intercity_confirm', 'idle'],
  'intercity_confirm': ['waiting_driver', 'idle'],
  // Переходы из любого состояния в idle всегда допустимы (сброс)
}

/**
 * Проверяет допустимость перехода (без блокировки).
 */
const isValidTransition = (from, to) => {
  if (to === 'idle') return true // Сброс всегда допустим
  if (to.startsWith('reg_') || to.startsWith('edit_') || to.startsWith('admin_')) return true
  const allowed = ALLOWED_TRANSITIONS[from] || []
  return allowed.includes(to)
}

/**
 * Выполняет переход состояния с логированием.
 * Не блокирует даже при невалидном переходе — просто логирует warning.
 */
const transition = async (phone, newState, ctx = {}) => {
  // Валидируем новое состояние
  if (!VALID_STATES.has(newState)) {
    log.warn('stateMachine', 'unknown_state', { phone, state: newState })
  }

  const session = await q.getSession(phone)
  const fromState = session?.state || 'idle'

  if (!isValidTransition(fromState, newState)) {
    log.warn('stateMachine', 'invalid_transition', { phone, from: fromState, to: newState })
  }

  await q.setSession(phone, newState, ctx)
  log.driver(phone, 'transition', { from: fromState, to: newState })
  return { from: fromState, to: newState }
}

/**
 * Возвращает текущее состояние сессии.
 */
const getCurrentState = async (phone) => {
  const session = await q.getSession(phone)
  return session?.state || 'idle'
}

/**
 * Сбрасывает состояние в idle.
 */
const reset = async (phone) => transition(phone, 'idle', {})

module.exports = { transition, getCurrentState, isValidTransition, reset, VALID_STATES, ALLOWED_TRANSITIONS }
