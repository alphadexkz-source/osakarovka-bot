'use strict'

// Минимальные env-переменные чтобы config.js не вызвал process.exit(1)
process.env.ADMIN_PIN      = 'TEST_PIN_9999'
process.env.DRIVER_CODE    = 'TEST_CODE_9999'
process.env.DATABASE_URL   = 'postgresql://test:test@localhost:5432/test'
process.env.GREEN_API_ID   = 'test_instance'
process.env.GREEN_API_TOKEN = 'test_token'
process.env.GROQ_API_KEY   = 'test_groq_key'
