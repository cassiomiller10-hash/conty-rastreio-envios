# Exemplos de request e response

Gerados executando a API com o relógio controlado dos testes e o agregador falso, a partir do payload do desenho: postado em 05/10 (segunda), em trânsito, saiu para entrega em 07/10 e um código inventado (`XZ-77`) que o agregador chama de `Delivered`. Os ids mudam a cada execução.

Com `npm run dev`, o agregador falso sobe em `localhost:4007` (chave `chave-de-demonstracao`) e aceita checkpoints de simulação em `POST /_simulacao/{transportadora}/{codigo}/checkpoints`; os horários serão os do relógio real.

### 1. Cadastrar o envio (o código também é cadastrado no agregador)
```bash
curl -s -X POST localhost:3007/envios \
  -H 'content-type: application/json' \
  -d '{"campanha_id":"camp_verao26","criador_id":"cri_ana","transportadora":"correios","modalidade":"PAC","codigo":"QB123456789BR"}'
```
`201`
```json
{
  "envio": "env_227f4b85b0c9",
  "campanha": "camp_verao26",
  "criador": "cri_ana",
  "transportadora": "correios",
  "modalidade": "PAC",
  "codigo": "QB123456789BR",
  "status": null,
  "status_desde": null,
  "motivo_sem_status": "aguardando primeiro evento reconhecido",
  "precisa_revisao": false,
  "motivos_revisao": [],
  "postado_em": null,
  "entregue_em": null,
  "prazo": {
    "limite_dias_uteis": 7,
    "fonte_limite": "tabela (correios PAC)",
    "dias_uteis_em_transito": null,
    "atrasado": false
  },
  "previsao_entrega": {
    "inicial": null,
    "atual": null
  },
  "cadastrado_em": "2026-10-05T09:00:00-03:00",
  "ultima_consulta_em": null,
  "eventos": []
}
```

### 2. Payload bruto do agregador (o que o cliente HTTP recebe)
```bash
curl -s localhost:4007/v1/trackings/correios/QB123456789BR \
  -H 'x-api-key: chave-de-demonstracao'
```
`200`
```json
{
  "tracking_number": "QB123456789BR",
  "courier": "correios",
  "service": "PAC",
  "expected_delivery": null,
  "checkpoints": [
    {
      "id": "cp_91a",
      "checkpoint_time": "2026-10-05T14:12:00",
      "raw_status": "PO-01",
      "message": "Objeto postado",
      "location": "São Paulo/SP",
      "tag": "InfoReceived"
    },
    {
      "id": "cp_91b",
      "checkpoint_time": "2026-10-06T08:40:00",
      "raw_status": "RO-01",
      "message": "Objeto em trânsito - por favor aguarde",
      "location": "Cajamar/SP",
      "tag": "InTransit"
    },
    {
      "id": "cp_91c",
      "checkpoint_time": "2026-10-07T09:05:00",
      "raw_status": "OEC-01",
      "message": "Objeto saiu para entrega ao destinatário",
      "location": "Campinas/SP",
      "tag": "OutForDelivery"
    },
    {
      "id": "cp_91d",
      "checkpoint_time": "2026-10-07T11:30:00",
      "raw_status": "XZ-77",
      "message": "Objeto aguardando conferência especial",
      "location": "Campinas/SP",
      "tag": "Delivered"
    }
  ]
}
```

### 3. Consultar: o mesmo envio, normalizado (o código XZ-77 com categoria 'Delivered' não vira entregue)
```bash
curl -s -X POST localhost:3007/envios/env_227f4b85b0c9/consultar
```
`200`
```json
{
  "consulta": {
    "eventos_recebidos": 4,
    "eventos_novos": 4,
    "eventos_invalidos": [],
    "avisos": [
      "codigo_nao_reconhecido"
    ]
  },
  "envio": {
    "envio": "env_227f4b85b0c9",
    "campanha": "camp_verao26",
    "criador": "cri_ana",
    "transportadora": "correios",
    "modalidade": "PAC",
    "codigo": "QB123456789BR",
    "status": "saiu_para_entrega",
    "status_desde": "2026-10-07T09:05:00-03:00",
    "motivo_sem_status": null,
    "precisa_revisao": true,
    "motivos_revisao": [
      "código não reconhecido: XZ-77 (Objeto aguardando conferência especial)"
    ],
    "postado_em": "2026-10-05T14:12:00-03:00",
    "entregue_em": null,
    "prazo": {
      "limite_dias_uteis": 7,
      "fonte_limite": "tabela (correios PAC)",
      "dias_uteis_em_transito": 2,
      "atrasado": false
    },
    "previsao_entrega": {
      "inicial": null,
      "atual": null
    },
    "cadastrado_em": "2026-10-05T09:00:00-03:00",
    "ultima_consulta_em": "2026-10-07T12:00:00-03:00",
    "eventos": [
      {
        "data": "2026-10-05T14:12:00-03:00",
        "codigo_bruto": "PO-01",
        "descricao": "Objeto postado",
        "local": "São Paulo/SP",
        "status": "postado",
        "traduzido_por": "tabela",
        "conhecido_em": "2026-10-07T12:00:00-03:00",
        "id_agregador": "cp_91a"
      },
      {
        "data": "2026-10-06T08:40:00-03:00",
        "codigo_bruto": "RO-01",
        "descricao": "Objeto em trânsito - por favor aguarde",
        "local": "Cajamar/SP",
        "status": "em_transito",
        "traduzido_por": "tabela",
        "conhecido_em": "2026-10-07T12:00:00-03:00",
        "id_agregador": "cp_91b"
      },
      {
        "data": "2026-10-07T09:05:00-03:00",
        "codigo_bruto": "OEC-01",
        "descricao": "Objeto saiu para entrega ao destinatário",
        "local": "Campinas/SP",
        "status": "saiu_para_entrega",
        "traduzido_por": "tabela",
        "conhecido_em": "2026-10-07T12:00:00-03:00",
        "id_agregador": "cp_91c"
      },
      {
        "data": "2026-10-07T11:30:00-03:00",
        "codigo_bruto": "XZ-77",
        "descricao": "Objeto aguardando conferência especial",
        "local": "Campinas/SP",
        "status": null,
        "traduzido_por": "nenhum",
        "motivo": "código fora da tabela; a categoria 'Delivered' do agregador não é aceita para entregue (só a tabela define status que mexem em prazo)",
        "conhecido_em": "2026-10-07T12:00:00-03:00",
        "id_agregador": "cp_91d"
      }
    ]
  }
}
```

### 4. Consultar de novo: nenhum evento novo, nada duplica
```bash
curl -s -X POST localhost:3007/envios/env_227f4b85b0c9/consultar
```
`200`
```json
{
  "consulta": {
    "eventos_recebidos": 4,
    "eventos_novos": 0,
    "eventos_invalidos": [],
    "avisos": []
  },
  "eventos": 4
}
```

### 5. Verificação (19/10): consulta de novo os envios em aberto e só então decide os avisos
```bash
curl -s -X POST localhost:3007/verificacoes
```
`200`
```json
{
  "verificados": 1,
  "consultados": 1,
  "nao_confirmados": [],
  "avisos_emitidos": [
    {
      "envio": "env_227f4b85b0c9",
      "tipo": "excecao"
    },
    {
      "envio": "env_227f4b85b0c9",
      "tipo": "atraso"
    }
  ]
}
```

### 6. Avisos registrados
```bash
curl -s localhost:3007/avisos
```
`200`
```json
[
  {
    "tipo": "codigo_nao_reconhecido",
    "envio": null,
    "criado_em": "2026-10-07T15:00:00.000Z",
    "detalhes": {
      "transportadora": "correios",
      "codigo_bruto": "XZ-77",
      "descricao": "Objeto aguardando conferência especial",
      "primeiro_envio": "env_227f4b85b0c9"
    }
  },
  {
    "tipo": "excecao",
    "envio": "env_227f4b85b0c9",
    "criado_em": "2026-10-19T12:00:00.000Z",
    "detalhes": {
      "codigo_bruto": "BDE-20",
      "descricao": "Destinatário ausente - nova tentativa",
      "data": "2026-10-07T13:00:00-03:00",
      "local": "Campinas/SP"
    }
  },
  {
    "tipo": "atraso",
    "envio": "env_227f4b85b0c9",
    "criado_em": "2026-10-19T12:00:00.000Z",
    "detalhes": {
      "postado_em": "2026-10-05T14:12:00-03:00",
      "dias_uteis_em_transito": 9,
      "limite_dias_uteis": 7,
      "fonte_limite": "tabela (correios PAC)",
      "status": "excecao"
    }
  }
]
```

### 7. Códigos que precisam entrar na tabela
```bash
curl -s localhost:3007/codigos-pendentes
```
`200`
```json
[
  {
    "transportadora": "correios",
    "codigo_bruto": "XZ-77",
    "descricao": "Objeto aguardando conferência especial",
    "traduzido_por": "nenhum",
    "status_pela_categoria": null,
    "envios_afetados": 1
  }
]
```
