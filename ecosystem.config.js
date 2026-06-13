module.exports = {
  apps: [
    {
      name: 'osakarovka-bot',
      script: 'src/index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'hermes-telegram',
      script: 'agent/telegram.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '150M',
      env: { NODE_ENV: 'production' },
    },
  ],
};
