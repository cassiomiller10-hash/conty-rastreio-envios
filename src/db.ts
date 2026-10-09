import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Só fatos são gravados: o envio, os eventos que a transportadora informou e os avisos emitidos.
// Status, atraso e data de entrega NÃO são gravados: são recalculados do histórico a cada leitura.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS envios (
  id TEXT PRIMARY KEY,
  campanha_id TEXT NOT NULL,
  criador_id TEXT NOT NULL,
  transportadora TEXT NOT NULL,
  modalidade TEXT NOT NULL,
  codigo TEXT NOT NULL,
  cadastrado_em TEXT NOT NULL,
  ultima_consulta_em TEXT,
  previsao_inicial TEXT,
  previsao_atual TEXT,
  UNIQUE (transportadora, codigo)
);

-- A identidade do evento é o fato (transportadora, código, instante, código bruto, local), já
-- normalizada: o mesmo fato, entregue por outro agregador ou com outro id, não duplica.
CREATE TABLE IF NOT EXISTS eventos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  envio_id TEXT NOT NULL REFERENCES envios(id),
  chave TEXT NOT NULL UNIQUE,
  data_utc TEXT NOT NULL,
  data_original TEXT NOT NULL,
  codigo_bruto TEXT NOT NULL,
  descricao TEXT NOT NULL,
  local TEXT,
  id_agregador TEXT,
  sugestao TEXT,
  categoria_agregador TEXT,
  conhecido_em TEXT NOT NULL
);

-- Avisos: a chave impede repetir o mesmo aviso (um atraso por envio, um aviso por código novo...).
CREATE TABLE IF NOT EXISTS avisos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL,
  envio_id TEXT,
  chave TEXT NOT NULL UNIQUE,
  criado_em TEXT NOT NULL,
  detalhes_json TEXT NOT NULL
);
`;

export function openDatabase(path = ":memory:"): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
