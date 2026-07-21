import type Database from "better-sqlite3";

export type StoredAiModelConfiguration = {
  provider: "openai-compatible";
  baseUrl: string;
  model: string;
  protectedApiKey: string;
  updatedAt: string;
};

export interface AiConfigurationStore {
  load(): StoredAiModelConfiguration | undefined;
  save(configuration: StoredAiModelConfiguration): void;
}

type ConfigurationRow = {
  provider: string;
  base_url: string;
  model: string;
  protected_api_key: string;
  updated_at: string;
};

export class SqliteAiConfigurationStore implements AiConfigurationStore {
  readonly #sqlite: Database.Database;

  public constructor(sqlite: Database.Database) {
    this.#sqlite = sqlite;
  }

  public load(): StoredAiModelConfiguration | undefined {
    const row = this.#sqlite
      .prepare(
        `SELECT provider, base_url, model, protected_api_key, updated_at
         FROM ai_model_configurations
         WHERE id = 1`,
      )
      .get() as ConfigurationRow | undefined;
    if (row === undefined || row.provider !== "openai-compatible") {
      return undefined;
    }
    return {
      provider: "openai-compatible",
      baseUrl: row.base_url,
      model: row.model,
      protectedApiKey: row.protected_api_key,
      updatedAt: row.updated_at,
    };
  }

  public save(configuration: StoredAiModelConfiguration): void {
    this.#sqlite
      .prepare(
        `INSERT INTO ai_model_configurations
          (id, provider, base_url, model, protected_api_key, updated_at)
         VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           provider = excluded.provider,
           base_url = excluded.base_url,
           model = excluded.model,
           protected_api_key = excluded.protected_api_key,
           updated_at = excluded.updated_at`,
      )
      .run(
        configuration.provider,
        configuration.baseUrl,
        configuration.model,
        configuration.protectedApiKey,
        configuration.updatedAt,
      );
  }
}
