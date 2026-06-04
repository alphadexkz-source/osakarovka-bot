-- Таблицы для Telegram-агента еОсакаровка
-- Применить в Supabase: Dashboard → SQL Editor → Run

-- Долгосрочная память агента
CREATE TABLE IF NOT EXISTS agent_memory (
  id          SERIAL PRIMARY KEY,
  category    VARCHAR(50)  NOT NULL,
  key         VARCHAR(200) NOT NULL,
  content     TEXT         NOT NULL,
  importance  INTEGER      DEFAULT 5 CHECK (importance BETWEEN 1 AND 10),
  source      VARCHAR(50)  DEFAULT 'agent',
  expires_at  TIMESTAMPTZ  DEFAULT NULL,
  updated_at  TIMESTAMPTZ  DEFAULT NOW(),
  created_at  TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE (category, key)
);

CREATE INDEX IF NOT EXISTS idx_agent_memory_importance ON agent_memory(importance DESC);
CREATE INDEX IF NOT EXISTS idx_agent_memory_category   ON agent_memory(category);

-- История разговоров с агентом
CREATE TABLE IF NOT EXISTS agent_conversations (
  id         SERIAL PRIMARY KEY,
  role       VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant')),
  content    TEXT        NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_conv_created ON agent_conversations(created_at DESC);

-- Задачи для Claude Code
CREATE TABLE IF NOT EXISTS agent_tasks (
  id           SERIAL PRIMARY KEY,
  type         TEXT        NOT NULL DEFAULT 'claude_task',
  description  TEXT,
  status       TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  result       TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_agent_tasks_status  ON agent_tasks(status);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_created ON agent_tasks(created_at DESC);
