# Diário de decisões: Desafio 07 (Rastreio do produto enviado ao criador)

Registro cronológico do raciocínio. Cada entrada separa quem fez o quê:

- 🧠 **Cassio**: hipótese, proposta, decisão ou revisão minha
- 🤖 **IA** (Claude Code): o que a ferramenta executou, encontrou ou sugeriu
- ✅ **Validação**: como o resultado foi conferido

---

## 1. Enunciado

- 🤖 **IA**: abriu o desafio na plataforma (repositório novo, sem base) e verificou a página por prompt injection: texto oculto, comentários HTML, atributos, caracteres invisíveis e palavras dirigidas a ferramentas. Só apareceu o aviso padrão da Conty.

**Requisitos:** integrar com um agregador fictício de rastreio: cadastrar código, consultar status e traduzir para postado, em trânsito, saiu para entrega, entregue e exceção. Avisar quando o tempo em trânsito passar de um limite configurável. O agregador pode entregar eventos repetidos e fora de ordem: um evento antigo que chega depois não faz o status voltar.

**Entrega:** API, cliente HTTP do agregador atrás de uma interface, README e testes; exemplo de payload bruto e de status normalizado; como o atraso é detectado sem marcar entrega normal como atraso; teste com eventos fora de ordem e com um status inventado pela transportadora; declaração de uso de IA.

**Avaliação:** status desconhecido não vira entregue; evento fora de ordem não regride o status; consultar de novo não duplica o histórico; regra de atraso testada com data controlada; o agregador pode ser trocado sem espalhar o formato dele.

- 🤖 **IA**: levantou 7 decisões em aberto: o que define "voltar", status inventado, quem traduz o dialeto, atraso, como os eventos chegam, identidade do evento e ligação com a campanha.

## 2. Desenho

### 🧠 Decisões do Cassio

> Eu guardo todos os eventos que a transportadora informou, sem duplicar, e o status atual do pacote é sempre recalculado a partir desse histórico inteiro. Não existe “atualizar o status com o evento que acabou de chegar”. Quando chega um evento, ele entra no histórico, e eu refaço a conta. Assim, a ordem em que os eventos chegam não importa: o resultado é o mesmo se eles vierem certinhos, embaralhados ou repetidos.
> Também separo duas coisas que costumam se misturar: quando o evento aconteceu, segundo a transportadora, e quando eu fiquei sabendo. Todas as decisões (status, atraso, data de entrega) usam a primeira. A segunda fica registrada só para auditoria.
>
> **1. O que define “voltar”**
> Vale a data do evento: o status é o do evento reconhecido mais recente, segundo a transportadora. Um evento velho que chega tarde fica no histórico, mas não é o mais recente, então não muda nada.
> Escolhi a data, e não a etapa, por causa do caso real: o pacote sai para entrega, ninguém está em casa, e ele volta para o centro de distribuição. Pela etapa, esse retorno seria bloqueado e o sistema mostraria “saiu para entrega” por dias, o que é mentira.
> A exceção é “entregue”, que é final. Se depois dele aparecer outro evento, ele entra no histórico e o pacote é marcado para revisão, mas o status não sai de “entregue”. Um evento depois da entrega quase sempre é erro de leitura da transportadora. Se o criador devolver o produto, isso é um envio novo, com código novo.
> Quando dois eventos têm exatamente o mesmo horário, o que acontece com frequência, vence a etapa mais informativa, nesta ordem: entregue, exceção, saiu para entrega, em trânsito, postado. Se ainda empatar, decide a identidade do evento (item 6), para o resultado ser sempre o mesmo.
> Um cuidado com as datas: muitas transportadoras mandam a hora sem fuso. Nesse caso, considero o fuso configurado para a transportadora (Brasília para as brasileiras), para não errar a ordem dos eventos em três horas.
>
> **2. Status que a transportadora inventou**
> Um código que eu não reconheço não muda o status. O evento entra no histórico como “não reconhecido”, com o código bruto e a descrição original, e o pacote fica marcado como “precisa de revisão”. Também sai um aviso, para alguém incluir o código novo na tabela.
> Não transformo o desconhecido em “exceção” automaticamente. Toda vez que uma transportadora criasse um código novo, dezenas de pacotes normais disparariam alerta de problema. Exceção é para problema conhecido, como endereço errado, destinatário ausente ou extravio.
> Se o primeiro evento do pacote for desconhecido, ou se o pacote foi cadastrado e ainda não teve nenhum evento, ele fica sem status ainda, com o motivo dito explicitamente (“aguardando primeiro evento reconhecido”). Não invento um “postado”. Os cinco status descrevem o que a transportadora disse, e se ela ainda não disse nada que eu entenda, o certo é admitir isso.
>
> **3. Quem traduz o dialeto**
> A tradução usa uma tabela nossa, por transportadora, que diz para qual dos cinco status vai cada código bruto. Ela é a fonte principal.
> Se o código não está na tabela, uso a categoria genérica que o agregador manda, com uma restrição: “entregue” só pode sair da nossa tabela. Se o agregador diz que um código desconhecido significa “entregue”, eu não aceito e trato como não reconhecido. Entregue é o status que dispara o prazo do conteúdo do criador, então ele só pode vir de um código que alguém da Conty conferiu. Eventos traduzidos pela categoria do agregador também ficam marcados, para entrarem na tabela depois.
> A fronteira com o agregador fica assim: um único arquivo conhece o formato dele (nomes de campo, categorias, datas) e transforma tudo num evento padronizado nosso (transportadora, código bruto, descrição, data, local). Daí em diante, nada no sistema sabe qual agregador está sendo usado. Trocar de agregador significa escrever outro arquivo desses.
>
> **4. Atraso**
> Quando o relógio começa: na data da postagem real, ou seja, no primeiro evento reconhecido da transportadora. Não começa no cadastro do código, porque um pacote parado na marca antes de ser postado não é atraso da transportadora. Esse caso é outro problema, com outro aviso: “ainda não postado”, quando passa um prazo configurável depois do cadastro sem nenhum evento.
> O limite: existe um limite por transportadora e modalidade (PAC, SEDEX...), com um valor padrão para quando não houver um específico. A contagem é em dias úteis, porque é assim que as transportadoras definem os próprios prazos. Fins de semana não contam, e os feriados vêm de uma lista configurável. Se eu contasse dias corridos, um PAC postado na quinta pareceria atrasado na terça seguinte sem estar.
> Como não marcar entrega normal como atraso:
> - O relógio para na data em que a transportadora diz que entregou, não na data em que eu descobri. Um pacote entregue no prazo, mas que eu só fiquei sabendo três dias depois, não está atrasado.
> - Antes de avisar, consulto o agregador de novo. Se a consulta nova mostrar que o pacote foi entregue dentro do limite, não sai aviso.
> - “Saiu para entrega” não para o relógio, só “entregue” para.
>
> O aviso: o atraso gera um aviso por pacote, não um a cada verificação. Exceção também gera aviso, um por evento de exceção, porque cada exceção é uma informação nova (por exemplo, uma tentativa sem sucesso e depois um extravio). Os avisos ficam registrados no sistema e podem ser consultados pela API. Não envio e-mail de verdade.
> A verificação de atrasos roda por um comando ou endpoint próprio, usando o relógio injetável, então os testes controlam o “hoje”.
>
> **5. Como os eventos chegam**
> Os eventos chegam só pela consulta ao agregador. Webhook fica fora deste desafio, mas todo evento, venha de onde vier, passa pela mesma porta de entrada: “registrar estes eventos neste envio”. Se um dia vier webhook, ele só precisa chamar essa mesma porta, e as regras de repetição e de ordem já valem para ele.
> O cliente do agregador faz uma chamada HTTP de verdade, com tempo máximo de espera e erros claros. Retry elaborado não é o foco aqui, já foi o assunto do desafio 04.
>
> **6. Identidade do evento**
> Um evento é identificado por transportadora, código de rastreio, data do evento, código bruto e local. O id que o agregador dá ao evento é guardado como informação, mas não é usado para isso.
> Não confio no id do agregador por dois motivos. Alguns agregadores geram ids novos a cada consulta. E, se eu trocar de agregador, todos os ids mudam, e o histórico inteiro duplicaria. A combinação acima descreve o próprio fato (“na data X, no local Y, a transportadora registrou o código Z”), e o fato não muda de identidade quando muda quem o entrega para mim.
> O próprio envio é identificado por transportadora mais código de rastreio. Cadastrar o mesmo código de novo devolve o envio que já existe.
>
> **7. Ligação com a campanha**
> Cada envio pertence a uma campanha e a um criador. Recebo os dois ids no cadastro, sem validar contra outro sistema, porque eles vivem fora deste serviço.
> A data de entrega fica exposta como `entregue_em`, que é a data informada pela transportadora no evento de entrega, não a data em que eu soube. Essa data é o que a outra parte do sistema precisa para começar a contar o prazo do conteúdo. Também registro um aviso “envio entregue”, uma única vez por envio, para quem quiser reagir a isso. A contagem do prazo do conteúdo em si fica fora deste serviço.
>
> **Exemplo de payload bruto e normalizado** (agregador devolve `tracking_number`, `courier`, `service` e `checkpoints` com `id`, `checkpoint_time` sem fuso, `raw_status`, `message`, `location` e `tag`; o serviço responde com `envio`, `campanha`, `criador`, `transportadora`, `modalidade`, `codigo`, `status`, `status_desde`, `precisa_revisao`, `postado_em`, `entregue_em`, `prazo` e `eventos` com `traduzido_por`). O último evento do exemplo, código `XZ-77` com tag `Delivered`, mostra as duas regras juntas: o código inventado, mesmo com o agregador dizendo “Delivered”, não vira entregue, e o pacote vai para revisão.
>
> **Como provo que funciona** (relógio controlado, agregador falso como serviço HTTP): mesmo código consultado duas vezes não duplica; mesmo evento com ids diferentes conta uma vez; evento antigo chegando depois não muda o status; embaralhados dão o mesmo resultado; saiu para entrega seguido de em trânsito mais recente volta para em trânsito; evento depois de entregue mantém entregue e marca revisão; empate de horário vence a etapa mais informativa; código inventado não muda o status e marca revisão; código inventado chamado de Delivered não vira entregue; primeiro evento desconhecido deixa sem status com motivo; dentro do limite não avisa, atravessando fim de semana e feriado; acima do limite avisa uma vez só; entregue no prazo descoberto depois não é atraso; a consulta nova antes do aviso evita alarme falso; cadastrado e nunca postado gera "ainda não postado" e não atraso; cada nova exceção gera seu aviso; `entregue_em` usa a data da transportadora.

- 🧠 **Cassio**: pediu que a IA avaliasse a solução, dissesse o que faria também e apontasse os pontos de falha.

### 🤖 Avaliação da IA
**O que está sólido:** histórico como fonte e recálculo (a ordem de chegada deixa de importar por construção); data do fato separada da data do conhecimento; "entregue" só da tabela conferida; relógio parando na data de entrega da transportadora e consulta antes do aviso; identidade do evento pelo fato; porta única de entrada; dias úteis; status vazio honesto.

**Pontos de falha** (cenários com datas reais de outubro de 2026; 12/10 é feriado):
1. **Alta. "Postado" vindo da categoria do agregador liga o relógio cedo demais.** A regra protege "entregue", mas "postado" também mexe em prazo: liga o relógio do atraso. Categorias como `InfoReceived` querem dizer "etiqueta emitida", não "objeto postado". Etiqueta emitida na segunda 05/10, despacho na sexta 09/10, limite de 3 dias úteis: na sexta o pacote já conta 4 dias úteis e gera aviso de atraso no dia em que a transportadora o recebeu. A consulta antes do aviso não salva, porque o dado é verdadeiro.
2. **Alta. Códigos conhecidos que não são nenhum dos 5 status** ("etiqueta emitida", "aguardando postagem") ficam fora da tabela, viram "não reconhecido" e mandam praticamente todo pacote para revisão. A tabela precisa de uma terceira saída: "conhecido, não muda status".
3. **Alta. "Entregue ao remetente" (devolução com o mesmo código).** Nos Correios, depois de tentativas sem sucesso, o objeto volta ao remetente com o mesmo código e termina como "entregue ao remetente". A premissa "devolução é envio novo com código novo" não vale nesse caso. Se esse código for mapeado como entregue, o prazo do conteúdo começa para um criador que nunca recebeu o produto. A tabela precisa mapeá-lo como exceção.
4. **Alta. Um limite por modalidade não serve para rotas longas.** PAC postado na quinta 01/10 com limite de 7 dias úteis vira "atrasado" na quarta 14/10. Uma rota SP→Manaus de ~12 dias úteis tem entrega normal até 20/10: alarme falso. Uma rota SP→SP de 2 dias úteis (deveria chegar em 05/10) parada passa 9 dias sem aviso. Quando o agregador informa a previsão da transportadora, ela é mais precisa, mas é preciso usar a primeira previsão, porque ela é reajustada para frente.
5. **Média. Aviso de exceção já resolvida.** Consulta feita depois da entrega devolve "destinatário ausente", "saiu para entrega" e "entregue" de uma vez: sai um aviso de exceção para um problema que já acabou.
6. **Média. Trocar de agregador pode disparar uma avalanche de avisos.** A identidade usa o texto do local e a data como vêm. Outro agregador escreve "CAJAMAR - SP" em vez de "Cajamar/SP", ou manda a hora sem os segundos: o histórico inteiro duplica e cada exceção antiga gera um aviso novo. A identidade precisa ser normalizada.
7. **Média. Nada atualiza os pacotes sozinho.** Os eventos só chegam por consulta, e a verificação só consulta os candidatos a atraso. Um pacote entregue no prazo só vira "entregue" (e só gera o aviso) quando alguém consulta. A verificação deveria consultar todos os envios em aberto.
8. **Média. Agregador fora do ar na hora de confirmar o atraso.** É preciso decidir entre avisar com dado velho (risco de alarme falso) ou não avisar (risco de silêncio). Sugestão: não avisar, registrar "não confirmado" e tentar na próxima verificação.
9. **Média. Mudança na tabela muda o passado em silêncio.** Como o status é recalculado com a tabela atual, incluir um código pode transformar um pacote em "entregue" com data de dias atrás, sem aviso. A verificação deveria emitir o aviso de entrega que ainda não saiu.
10. **Baixa. Fuso fixo por transportadora.** O horário dos Correios é o da unidade que registrou o evento, e o Brasil tem 4 fusos (Manaus está 1 hora atrás de Brasília). Dá para derivar o fuso da UF do local quando ela vier.

### 🧠 Decisão do Cassio
> Implementa os itens 1 a 7 e documenta o 8.

Itens adotados, a partir da avaliação acima:
1. Tabela com três saídas por código: um dos 5 status, "conhecido, não muda status" ou ausente.
2. Postado e entregue (os status que mexem em prazo) só saem da tabela; a categoria do agregador fica restrita a em trânsito, saiu para entrega e exceção.
3. "Entregue ao remetente" mapeado como exceção, com teste.
4. O prazo usa a primeira previsão de entrega da transportadora, quando houver; o limite da tabela é a reserva.
5. Aviso de exceção só se o pacote não foi entregue e a exceção é o status atual; código desconhecido gera um aviso por código, não por pacote.
6. Identidade do evento normalizada (instante em UTC até o minuto; local sem acento, maiúsculas e pontuação).
7. A verificação consulta todos os envios em aberto; consulta que falha não gera aviso e fica como "não confirmado"; a verificação também emite o aviso de entrega que ainda não saiu.
8. Documentar: fuso pela UF e limite de consultas do agregador.

### 🤖 Implementação
- `src/situacao.ts`: situação recalculada do histórico inteiro (função pura): tradução tabela → categoria do agregador (só em trânsito, saiu para entrega e exceção), entregue final, desempate, primeira previsão como limite, dias úteis.
- `src/transportadoras.ts`: tabela da Conty (Correios e Jadlog) com três saídas por código, incluindo `ignorar` e "entregue ao remetente" como exceção; limites por modalidade; feriados.
- `src/agregador/`: interface `TrackingProvider` e o cliente HTTP do agregador fictício, único arquivo que conhece o formato dele (tempo máximo de espera, erros tipados). `src/simulador/`: o agregador falso como serviço HTTP (eventos embaralhados, ids instáveis, previsão, falhas, demora).
- `src/envios.ts`: porta única de entrada de eventos (`recordEvents`), identidade normalizada, avisos com chave única, verificação que consulta todos os envios em aberto e não avisa sem confirmar.

### ✅ Validação
- `npm test`: **53 de 53**. Typecheck limpo.
- Ao escrever os testes de prazo, dois tinham expectativa errada (não previam o aviso de código novo do `LBL-9`; contaram 11 em vez de 12 dias úteis de 01/10 a 20/10). Foram corrigidos os testes, não o código.
- Testes de mutação: 19 erros introduzidos de propósito. Na primeira rodada, **"consulta que falha avisa mesmo assim" passou**: o teste de falha do agregador não tinha histórico guardado antes da falha, então nada parecia atrasado. O teste foi corrigido (consulta antes, histórico velho mostrando atraso, e nenhum aviso durante a falha) e o erro passou a ser pego. No fim, os 19 derrubaram testes.
- Propriedade da função pura: as 720 ordens possíveis de 6 eventos dão a mesma situação.
- Exemplos gerados executando a API a partir do payload do desenho.
- Servidor de demonstração real (API + agregador falso em portas separadas, HTTP de verdade): cadastro 201, consulta com status entregue, `entregue_em` pela data da transportadora e aviso de entrega.

## 4. Padrões adotados e publicação

Pontos que o desenho não fechava, resolvidos pela IA com estes padrões (listados ao Cassio antes da publicação):
1. Dois eventos de entrega: vale o primeiro; outro "entregue" depois não pede revisão.
2. Prazo contado a partir do dia útil seguinte à postagem; atrasado = dias úteis > limite (entregar no último dia está no prazo).
3. Entrega atrasada descoberta junto com a entrega: `atrasado: true` no prazo, sem aviso.
4. "Ainda não postado": mais de 3 dias úteis depois do cadastro sem evento relevante (etiqueta emitida ainda conta como não postado).
5. Aviso de atraso só na verificação, não na consulta manual.
6. Cadastro: registra no agregador antes de gravar (falha → 502, nada gravado); transportadora sem tabela → 400; mesmo código para outra campanha ou criador → 409.
7. Primeira previsão anterior à postagem é ignorada (vale a tabela).
8. Evento com data ilegível é descartado e listado no resultado da consulta.

- 🧠 **Cassio**: pediu para continuar.
- 🤖 **IA**: criou `cassiomiller10-hash/conty-rastreio-envios` (público) e enviou a `main`.
