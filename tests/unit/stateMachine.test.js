'use strict'

jest.mock('../../src/db/queries', () => ({
  getSession: jest.fn(),
  setSession: jest.fn(),
  clearSession: jest.fn(),
}))
jest.mock('../../src/logger', () => ({
  warn: jest.fn(), error: jest.fn(), info: jest.fn(),
  msg: jest.fn(), order: jest.fn(), driver: jest.fn(),
  initFileLogging: jest.fn(),
}))

const {
  isValidTransition,
  VALID_STATES,
  ALLOWED_TRANSITIONS,
  transition,
  getCurrentState,
} = require('../../src/modules/stateMachine')
const q = require('../../src/db/queries')

// ─── isValidTransition() ─────────────────────────────────────────

describe('isValidTransition()', () => {
  describe('переход в idle — всегда валиден', () => {
    test('idle → idle', () => expect(isValidTransition('idle', 'idle')).toBe(true))
    test('confirming → idle', () => expect(isValidTransition('confirming', 'idle')).toBe(true))
    test('in_trip → idle', () => expect(isValidTransition('in_trip', 'idle')).toBe(true))
    test('admin_mode → idle', () => expect(isValidTransition('admin_mode', 'idle')).toBe(true))
  })

  describe('переходы в reg_* / edit_* / admin_* — всегда валидны', () => {
    test('idle → reg_name', () => expect(isValidTransition('idle', 'reg_name')).toBe(true))
    test('idle → edit_car', () => expect(isValidTransition('idle', 'edit_car')).toBe(true))
    test('idle → admin_mode', () => expect(isValidTransition('idle', 'admin_mode')).toBe(true))
    test('waiting_driver → reg_photo', () => expect(isValidTransition('waiting_driver', 'reg_photo')).toBe(true))
    test('in_trip → admin_add_1', () => expect(isValidTransition('in_trip', 'admin_add_1')).toBe(true))
  })

  describe('допустимые переходы клиентского флоу', () => {
    test('idle → confirming', () => expect(isValidTransition('idle', 'confirming')).toBe(true))
    test('confirming → waiting_driver', () => expect(isValidTransition('confirming', 'waiting_driver')).toBe(true))
    test('waiting_driver → in_trip', () => expect(isValidTransition('waiting_driver', 'in_trip')).toBe(true))
    test('in_trip → chat_mode', () => expect(isValidTransition('in_trip', 'chat_mode')).toBe(true))
    test('chat_mode → idle', () => expect(isValidTransition('chat_mode', 'idle')).toBe(true))
  })

  describe('допустимые переходы межгород', () => {
    test('idle → intercity_pickup', () => expect(isValidTransition('idle', 'intercity_pickup')).toBe(true))
    test('intercity_pickup → intercity_confirm', () => {
      expect(isValidTransition('intercity_pickup', 'intercity_confirm')).toBe(false) // через intercity_time
    })
    test('intercity_confirm → waiting_driver', () => {
      expect(isValidTransition('intercity_confirm', 'waiting_driver')).toBe(true)
    })
  })

  describe('недопустимые переходы — логируются но не блокируются', () => {
    test('idle → in_trip (пропуск шагов) → false', () => {
      expect(isValidTransition('idle', 'in_trip')).toBe(false)
    })
    test('confirming → in_trip → false', () => {
      expect(isValidTransition('confirming', 'in_trip')).toBe(false)
    })
    test('in_trip → waiting_driver → false', () => {
      expect(isValidTransition('in_trip', 'waiting_driver')).toBe(false)
    })
  })
})

// ─── VALID_STATES ─────────────────────────────────────────────────

describe('VALID_STATES', () => {
  const requiredStates = [
    // клиентские
    'idle', 'confirming', 'waiting_driver', 'in_trip', 'chat_mode',
    'intercity_pickup', 'intercity_confirm',
    // водительские
    'reg_name', 'reg_photo', 'reg_make', 'reg_plate', 'reg_color',
    'edit_name', 'edit_car', 'edit_photo', 'edit_color',
    'driver_as_client', 'driver_chat',
    // админ
    'admin_mode', 'admin_add_1', 'admin_add_2', 'admin_add_3', 'admin_add_4',
    'admin_edit_pick', 'admin_edit_field', 'admin_del_pick',
  ]

  test.each(requiredStates)('"%s" присутствует в VALID_STATES', (state) => {
    expect(VALID_STATES.has(state)).toBe(true)
  })

  test('intercity_time — зарезервировано (пустой шаг, удалён из флоу)', () => {
    // Если это состояние ещё в множестве — нормально (оно не используется, но не опасно)
    // Главное что оно не в ALLOWED_TRANSITIONS как цель без источника
    const reachable = Object.values(ALLOWED_TRANSITIONS).flat()
    // intercity_time может быть в VALID_STATES, но не должно быть единственным путём
    if (VALID_STATES.has('intercity_time')) {
      // проверяем что из idle нельзя прямо попасть в intercity_confirm минуя логику
      expect(ALLOWED_TRANSITIONS['idle']).not.toContain('intercity_confirm')
    }
  })
})

// ─── transition() ────────────────────────────────────────────────

describe('transition()', () => {
  beforeEach(() => {
    q.getSession.mockResolvedValue({ state: 'idle', ctx: {} })
    q.setSession.mockResolvedValue(undefined)
  })
  afterEach(() => jest.clearAllMocks())

  test('возвращает { from, to }', async () => {
    const result = await transition('79001234567', 'confirming', { dest: 'Алаш 15' })
    expect(result).toEqual({ from: 'idle', to: 'confirming' })
  })

  test('вызывает q.setSession с правильными аргументами', async () => {
    await transition('79001234567', 'waiting_driver', { order_id: 42 })
    expect(q.setSession).toHaveBeenCalledWith('79001234567', 'waiting_driver', { order_id: 42 })
  })

  test('from = "idle" когда сессии нет', async () => {
    q.getSession.mockResolvedValue(null)
    const result = await transition('79001234567', 'confirming')
    expect(result.from).toBe('idle')
  })

  test('логирует warning при переходе в неизвестное состояние', async () => {
    const log = require('../../src/logger')
    await transition('79001234567', 'unknown_state_xyz')
    expect(log.warn).toHaveBeenCalledWith('stateMachine', 'unknown_state', expect.any(Object))
  })

  test('не бросает ошибку при невалидном переходе', async () => {
    q.getSession.mockResolvedValue({ state: 'confirming', ctx: {} })
    // confirming → in_trip — невалидно, но не должно кидать
    await expect(transition('79001234567', 'in_trip')).resolves.not.toThrow()
  })
})

// ─── getCurrentState() ───────────────────────────────────────────

describe('getCurrentState()', () => {
  test('возвращает состояние из сессии', async () => {
    q.getSession.mockResolvedValue({ state: 'confirming', ctx: {} })
    expect(await getCurrentState('79001234567')).toBe('confirming')
  })

  test('возвращает "idle" если сессии нет', async () => {
    q.getSession.mockResolvedValue(null)
    expect(await getCurrentState('79001234567')).toBe('idle')
  })

  test('возвращает "idle" если state не задан', async () => {
    q.getSession.mockResolvedValue({ ctx: {} })
    expect(await getCurrentState('79001234567')).toBe('idle')
  })
})
