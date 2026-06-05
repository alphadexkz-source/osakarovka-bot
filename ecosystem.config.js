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
    // hermes-agent отключён — слишком много ложных алертов
    // Включить: pm2 start hermes-agent -- loop
  ],
};
