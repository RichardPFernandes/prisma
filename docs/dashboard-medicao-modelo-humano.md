# Medição de roteamento em sombra (dashboard)

## O quê

Painel no dashboard do Espectro que mostra **o que o roteamento teria escolhido** por pedaço de trabalho — leve, médio ou Opus — **sem trocar o modelo na prática**.

Você vê:

1. **Contagem por faixa** (leve / médio / Opus) e quantas subtarefas *sairiam* do Opus.
2. **Economia potencial** se, no futuro, essas faixas fossem usadas de verdade — comparado a “tudo em Opus”.
3. **Lista recente** das decisões sombra (run, subtarefa, classe, faixa, regra).

Isto **não** liga a troca real de modelo. O watcher continua despachando como hoje.

## Por quê

Hoje quase tudo vai para o modelo mais caro e o limite acaba rápido. Antes de mudar o despacho, precisamos **medir** quantas tarefas leves queimariam Opus à toa. Sem esse número, ligar a troca automática é chute — risco de qualidade e de retrabalho.

No dia a dia: a aba **Operação › Roteamento de modelo › Sombra × real** deixa o Richard (e a equipe) ver o desvio potencial **antes** de qualquer decisão de ativar roteamento real.

## Quando

| Já passou | Agora | Ainda não |
| --- | --- | --- |
| Sinais por subtarefa (observar tamanho/risco) | Painel que agrega `would_route` | Troca real de modelo no despacho (S4) |
| Policy + registro sombra por Attempt | Ligar regra barata na policy de sombra se ainda estiver “off” (senão a lista fica vazia de decisões) | Aprovar S4 / mudar argv |

Vale quando há Attempts com `would_route` gravado. Com classificador **desligado**, o painel mostra “sem decisão” — a infraestrutura existe, mas ainda não classifica.

## Próximos passos

1. Abrir o dashboard → **Operação › Roteamento de modelo**, aba **Sombra × real**, e conferir contagens / lista.
2. Policy de sombra na plataforma usa **`cheap_rule`** (medição). Attempts **antigos** com `CLASSIFIER_OFF` não reclassificam — só **novos** fechamentos de implement enchem leve/médio/Opus.
3. Se ainda houver zeros: painel **Diagnóstico dos zeros** (Attempts velhos off, ou falta de sinais). Detalhe histórico: store `docs/medicao-sombra-zeros-humano.md` · ligar medição: `docs/cheap-rule-ligado-humano.md`.
4. Usar a economia potencial e a contagem “sairia do Opus” como evidência **antes** de qualquer autorização de troca real.
5. **Não** autorizar S4 nesta fatia.

---

# Parte técnica (legível)

## O que foi achado

A fatia S3 ([PRI-223](https://linear.app/prisma-app/issue/PRI-223), PR [#78](https://github.com/RichardPFernandes/prisma/pull/78)) grava no Attempt um bloco **`would_route`** (decisão de roteamento **em sombra**: registrada, nunca aplicada ao despacho). O dashboard agora lê esses blocos em `state.json` → `cost_tracking` e agrega:

- contagem por **faixa** (`T1`=leve, `T2`=médio, `T3`=Opus);
- **economia potencial vs Opus-only** (hipótese de preço);
- lista recente de decisões.

## Por que importa

Sem UI de medição, o dado sombra fica só no JSON dos Attempts — difícil calibrar e decidir S4 com evidência atribuível. O painel é **somente leitura**; `applied` deve permanecer `false` (anomalia se `true`).

## Glossário (1ª ocorrência)

- **`would_route`** — registro sombra “qual classe/faixa *seria*” por subtarefa; não muda `--model`/esforço.
- **Faixa / tier** — `T1` leve, `T2` médio, `T3` Opus (capacidade mínima; **não** ranking de custo real).
- **`leaves_opus_tier`** — subtarefa cuja faixa sombra é T1 ou T2 (sairia do Opus).
- **S4** — fatia futura que *aplicaria* a decisão no despacho; **fora** deste trabalho.
- **Policy de sombra** — `scripts/lib/model-routing-policy.s3-shadow.json` (`classifier.provider=cheap_rule` na plataforma; `off` ainda válido; `mode=SHADOW`, sem S4).
- **Opus-only** — baseline “tudo no modelo caro”; custo observado do Attempt é tratado como essa baseline enquanto o despacho for AS-IS.
- **AS-IS** — despacho igual ao de hoje (argv/modelo/esforço inalterados).

## Superfície

| Peça | Path |
| --- | --- |
| Agregação | `dashboard/would-route-metrics.js` |
| API | `GET /api/would-route-metrics` (`dashboard/server.js`) |
| UI | `dashboard/public/would-route-metrics.js` + `screens/would-route.css` |
| Nav | Operação › Roteamento de modelo, aba Sombra × real (`routing.js`; o hash antigo `#medicao-modelo` continua abrindo essa aba) |
| Base sombra | `scripts/lib/would-route.js`, `cost-tracking`, schema Attempt |

## Economia potencial (hipótese)

Enquanto os modelos na policy estão `UNAVAILABLE`, a economia usa razões aproximadas de preço de **input** (Haiku/Sonnet/Opus na tabela `scripts/lib/model-pricing.json`):

| Tier | Faixa | Razão vs Opus | Economia cotada na cota do Attempt |
| --- | --- | --- | --- |
| T1 | leve | 0,2 | 80% da cota |
| T2 | médio | 0,6 | 40% da cota |
| T3 | Opus | 1,0 | 0 |

A cota de um Attempt com N decisões é `cost_usd / N`. Sem `cost_usd` observado → campos de economia ficam `null` (nunca zero inventado).

## Como verificar

```bash
node --test dashboard/would-route-metrics.test.js dashboard/would-route-metrics-api.test.js
# + suíte would-route da S3, se a base estiver no branch:
node --test scripts/lib/would-route.test.js
```

No UI: aba Sombra × real de Roteamento (hash antigo `#medicao-modelo` redireciona); banner “Só medição em sombra”.

## O que isto **não** é

- Não é S4 / `mode=ON` / mudança de argv.
- Não é Approval, Done Linear nem merge implícito.
- Não promove o mapa skill→modelo da esteira Cursor a Authority do watcher.

Issue sombra: [PRI-223](https://linear.app/prisma-app/issue/PRI-223) · Plano: store `docs/plano-roteamento-modelos-humano.md`
