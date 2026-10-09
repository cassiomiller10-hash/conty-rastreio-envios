# Rastreio do produto enviado ao criador

Integra com um agregador de rastreio (fictício, rodando como serviço HTTP), traduz o dialeto de cada transportadora para cinco status estáveis (**postado, em trânsito, saiu para entrega, entregue, exceção**) e avisa quando o tempo em trânsito passa do limite, sem marcar entrega normal como atraso.

## Como rodar

Node 22.

```bash
npm install
npm test
npm run dev   # API em http://127.0.0.1:3007 e agregador falso em http://127.0.0.1:4007
```

Exemplo de payload bruto do agregador e do status normalizado, e os demais requests: [`docs/EXEMPLOS.md`](docs/EXEMPLOS.md).

## A ideia central

**O status nunca é "atualizado com o evento que chegou".** Todos os eventos que a transportadora informou ficam no histórico, sem duplicar, e a situação (status, data de postagem, data de entrega, atraso) é **recalculada do histórico inteiro** a cada leitura ([`src/situacao.ts`](src/situacao.ts), função pura). Por isso a ordem de chegada não importa: um teste confere que as 720 ordens possíveis de 6 eventos dão exatamente o mesmo resultado.

**Duas datas, separadas:** quando o evento aconteceu (segundo a transportadora) e quando ficamos sabendo. Todas as decisões usam a primeira; a segunda fica só para auditoria (`conhecido_em`).

## Status

- **Vale o evento reconhecido mais recente pela data da transportadora.** Um evento velho que chega tarde fica no histórico e não muda nada. O status pode voltar de verdade: "saiu para entrega" seguido de um "em trânsito" mais recente (ninguém em casa, o pacote voltou ao centro de distribuição) é em trânsito.
- **"Entregue" é final.** Vale o primeiro evento de entrega; evento depois dele vai para o histórico e marca o envio para revisão, mas o status fica "entregue".
- **Empate de horário:** vence a etapa mais informativa (entregue > exceção > saiu para entrega > em trânsito > postado) e, por fim, a identidade do evento.
- **Hora sem fuso** é lida no fuso da transportadora (Brasília para as brasileiras); hora com fuso é respeitada.
- **Sem evento reconhecido, não há status** (`null`), com o motivo `aguardando primeiro evento reconhecido`. Nenhum "postado" é inventado.

## Quem traduz o dialeto

1. **A tabela da Conty** ([`src/transportadoras.ts`](src/transportadoras.ts)), por transportadora, é a fonte principal. Cada código tem uma de três saídas: um dos 5 status; **`ignorar`** (código conhecido que não é status, como "etiqueta emitida"); ou ausente.
2. **Código fora da tabela:** usa a categoria genérica do agregador, **mas só para em trânsito, saiu para entrega e exceção.** "Postado" e "entregue" mexem em prazo (o primeiro liga o relógio do atraso; o segundo dispara o prazo do conteúdo do criador) e só podem vir da tabela conferida. Um código novo que o agregador chama de `Delivered` **não vira entregue**, e um `InfoReceived` (etiqueta emitida) **não liga o relógio**.
3. **Código não reconhecido não muda o status:** entra no histórico com o código bruto e a descrição, marca o envio para revisão e gera **um aviso por código** (não por pacote). `GET /codigos-pendentes` lista o que precisa entrar na tabela.
4. **"Entregue ao remetente"** (devolução com o mesmo código) está na tabela como **exceção**: para o criador, é problema, não entrega.

Incluir um código na tabela recalcula o histórico: um envio pode passar a "entregue" com a data da transportadora, e a próxima verificação emite o aviso de entrega.

## Atraso, sem marcar entrega normal como atraso

- **O relógio liga na postagem real** (o primeiro evento reconhecido), não no cadastro. Pacote cadastrado e nunca postado gera outro aviso: **"ainda não postado"** (padrão: mais de 3 dias úteis sem evento relevante).
- **Dias úteis** (fins de semana e feriados configuráveis não contam), contados a partir do dia útil seguinte à postagem. **Atrasado = dias úteis em trânsito > limite.**
- **O limite:** a **primeira previsão de entrega** da transportadora, quando o agregador informa. Vale a primeira porque a transportadora reajusta a previsão para frente, e o atraso nunca chegaria. Sem previsão, vale o limite da tabela por transportadora e modalidade (Correios PAC 7, SEDEX 3).
- **O relógio para na data em que a transportadora entregou**, não na data em que soubemos. Entrega no prazo descoberta dias depois não é atraso.
- **A verificação** (`POST /verificacoes`, agendada em produção) **consulta de novo todos os envios em aberto** e só depois decide. Se a consulta mostrar que o pacote foi entregue, não sai aviso de atraso. **Se o agregador falhar, não avisa**: o envio fica em `nao_confirmados` e é tentado de novo na próxima verificação.

Avisos (`GET /avisos`), cada um uma única vez: **atraso** (por envio), **ainda não postado** (por envio), **entregue** (por envio), **exceção** (por evento de exceção, só enquanto ela é o status atual e o pacote não foi entregue: exceção já resolvida quando ficamos sabendo não avisa) e **código não reconhecido** (por código da transportadora).

## Fronteira com o agregador

- [`src/agregador/provedor.ts`](src/agregador/provedor.ts): a interface `TrackingProvider` e o evento padronizado da Conty.
- [`src/agregador/rastreio-falso.ts`](src/agregador/rastreio-falso.ts): **o único arquivo que conhece o formato do agregador** (rotas, campos, categorias, datas). Cliente HTTP de verdade, com tempo máximo de espera e erros claros (`tempo_esgotado`, `http`, `formato`, `rede`).
- Trocar de agregador = escrever outro arquivo como esse. Um teste estático ([`test/fronteira.test.ts`](test/fronteira.test.ts)) falha se o formato do agregador aparecer em qualquer outro arquivo de `src/`.
- **Porta única de entrada de eventos** (`recordEvents`): consulta, um webhook futuro ou outro agregador passam por ela, e as regras de repetição e de ordem valem para todos.

## Identidade do evento (o histórico não duplica)

Um evento é **o fato**: transportadora + código de rastreio + instante (em UTC, até o minuto) + código bruto + local (sem acento, maiúsculas ou pontuação). O id do agregador é guardado, mas não usado: alguns agregadores trocam o id a cada consulta, e trocar de agregador trocaria todos. Com a normalização, o mesmo fato escrito por outro agregador ("CAJAMAR - SP" e "Cajamar/SP", hora com ou sem segundos) não duplica o histórico nem repete aviso.

## Endpoints

| Endpoint | O que faz |
|---|---|
| `POST /envios` `{ campanha_id, criador_id, transportadora, modalidade, codigo }` | Cadastra o envio (e o código no agregador). O mesmo código devolve o envio existente; de outra campanha ou criador, 409 |
| `GET /envios/:id` | Situação recalculada: status, motivos de revisão, `postado_em`, `entregue_em`, prazo e eventos traduzidos |
| `POST /envios/:id/consultar` | Consulta o agregador agora e registra os eventos |
| `POST /verificacoes` | Consulta os envios em aberto e emite avisos |
| `GET /avisos` | Avisos (`?tipo=`, `?envio=`) |
| `GET /codigos-pendentes` | Códigos fora da tabela, com quantos envios afetam |

Agregador indisponível responde **502** com o tipo da falha; no cadastro, nada é gravado.

## Testes

`npm test` roda 53 testes. O relógio é controlado e o agregador falso roda como serviço HTTP (o cliente faz requisições de verdade a ele):

- **Histórico:** consulta repetida, ids instáveis, evento antigo chegando depois, ordem embaralhada, volta de saiu para entrega para em trânsito, evento depois da entrega, empate de horário, fuso.
- **Dialeto:** o payload do desenho (`XZ-77` com `Delivered`), código inventado, categoria aceita para trânsito, primeiro evento desconhecido, etiqueta emitida, `ignorar` e entregue ao remetente.
- **Prazo:** dentro do limite atravessando fim de semana e o feriado de 12/10, acima do limite (um aviso só), entrega no prazo descoberta depois, consulta antes do aviso evitando alarme falso, ainda não postado, etiqueta na segunda e despacho na sexta, primeira previsão (rota longa, previsão reajustada, rota curta), agregador fora do ar e mudança na tabela.
- **Avisos:** cada nova exceção, exceção já resolvida, entrega uma vez só e código novo uma vez por código.
- **Função pura:** as 720 ordens possíveis de 6 eventos dão a mesma situação.
- **Cliente HTTP:** formato, cadastro idempotente, tempo esgotado, erro HTTP, chave errada e resposta fora do formato.

Para conferir que os testes pegam erros de verdade, foram introduzidos 19 erros de propósito, entre eles: status pela ordem de chegada, status que nunca volta, entregue deixando de ser final, categoria do agregador aceita para entregue e postado, desconhecido virando exceção, dias corridos, relógio parando quando soubemos, previsão atual em vez da primeira, aviso sem consultar antes, verificação só dos candidatos, exceção resolvida avisando, aviso de código por pacote, identidade sem normalizar e hora sem fuso lida como UTC. Cada um derrubou ao menos um teste. Na primeira rodada, "consulta que falha avisa mesmo assim" passou: o teste não guardava histórico antes da falha. O teste foi corrigido e o erro passou a ser pego.

## Limitações e o que eu faria com mais tempo

- **Fuso pela UF do evento.** Hoje a hora sem fuso usa o fuso da transportadora (Brasília). O horário dos Correios é o da unidade que registrou o evento, e o Brasil tem 4 fusos: Manaus está 1 hora atrás. Em casos raros (eventos próximos em estados diferentes, ou perto da meia-noite), a ordem ou o dia do evento sai errado. Com mais tempo, o fuso seria derivado da UF do local quando ela vier.
- **Limite de consultas do agregador.** A verificação consulta todos os envios em aberto a cada rodada. Com volume, isso esbarra na cota do agregador (o assunto do desafio 04). Faria lotes, espaçaria as consultas pelo tempo desde o último evento e trataria 429 com `Retry-After`.
- **Webhook do agregador** fora do escopo; quando vier, chama a mesma porta de entrada (`recordEvents`).
- **Agregador sem código bruto da transportadora:** alguns só mandam a categoria deles e a mensagem. O cliente teria de derivar um código estável da mensagem normalizada.
- **Limite por rota:** sem previsão da transportadora, o limite é por modalidade. Uma tabela por região de destino deixaria o limite de reserva mais justo.
- **Entrega com atraso descoberta junto com a entrega** mostra `atrasado: true` no prazo, mas não gera aviso (não há o que fazer); a contagem do prazo do conteúdo fica fora deste serviço.
- **Sem autenticação** na API deste serviço.

## Uso de IA

Ferramenta: Claude Code (Claude Opus 5.5).

- **Decisões minhas:** histórico como fonte e status sempre recalculado; data do evento separada da data em que soube; status pelo evento mais recente pela data (não pela etapa), com entregue final e revisão para evento posterior; desempate pela etapa mais informativa; fuso da transportadora para hora sem fuso; desconhecido não muda status, vai para revisão e gera aviso, sem virar exceção; sem status quando não há evento reconhecido; tabela nossa por transportadora como fonte principal, categoria do agregador como reserva e entregue só da tabela; um único arquivo conhecendo o agregador; relógio na postagem real, "ainda não postado" à parte, limite por transportadora e modalidade em dias úteis com feriados, relógio parando na entrega da transportadora e consulta antes do aviso; um aviso de atraso por envio, avisos de exceção e de entrega; eventos só pela consulta, com porta única de entrada; identidade do evento pelo fato; ligação com campanha e criador, e `entregue_em` pela data da transportadora; a lista do que os testes precisam provar. Depois da avaliação da IA, decidi adotar os itens 1 a 7 e documentar o 8.
- **Feito pela IA:** a verificação de prompt injection na página; a avaliação da solução com os pontos de falha e cenários com datas reais (etiqueta emitida ligando o relógio, códigos conhecidos que não são status, entregue ao remetente, limite único para rotas longas, aviso de exceção resolvida, troca de agregador duplicando o histórico, envios sem atualização, falha do agregador na confirmação, mudança de tabela sem aviso, fuso); a proposta dos itens 1 a 8; os padrões para os pontos que o desenho não fechava (seção 4 do `DECISOES.md`); toda a implementação, os testes e os testes de mutação; os exemplos, gerados executando a API; o rascunho deste README.
- **O que revisei:** a revisão foi feita ao longo do processo, junto com a ferramenta. Cada decisão foi discutida comigo antes de virar código, e acompanhei os testes, os erros introduzidos de propósito e as validações.

O raciocínio passo a passo, separando o que foi meu e o que foi da IA, está em [`DECISOES.md`](DECISOES.md).
