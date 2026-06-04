'use strict'

module.exports = {
  testEnvironment: 'node',
  setupFiles: ['./tests/setup.js'],
  testMatch: ['**/tests/**/*.test.js'],
  collectCoverageFrom: [
    'src/modules/tariffEngine.js',
    'src/modules/voiceUtils.js',
    'src/modules/voiceCommands.js',
    'src/modules/stateMachine.js',
    'src/handlers/clientOrderHandler.js',
  ],
  coverageReporters: ['text', 'lcov'],
}
