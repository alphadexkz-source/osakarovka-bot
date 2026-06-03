// Barrel re-export всех query модулей
const userQueries    = require('./userQueries')
const driverQueries  = require('./driverQueries')
const orderQueries   = require('./orderQueries')
const sessionQueries = require('./sessionQueries')
const tariffQueries  = require('./tariffQueries')
const adminQueries   = require('./adminQueries')
const referralQueries = require('./referralQueries')

module.exports = {
  ...userQueries,
  ...driverQueries,
  ...orderQueries,
  ...sessionQueries,
  ...tariffQueries,
  ...adminQueries,
  ...referralQueries,
}
