# Geração integrada ao Studio — Etapa 4

Branch: `codex/studio-generation-flow`. A entrega conecta contratos, persistência e adaptador existentes a endpoints autenticados e ao painel de `/studio`. Não cria migração, configuração de IA, credencial, recurso Cloudflare, deploy ou publicação. A Etapa 5 não foi iniciada.

## Fluxo e preservação

O usuário abre um projeto, salva/revisa/aprova a versão exata do briefing e autoriza os cinco campos públicos essenciais. A aprovação, versão, hash e uso público são relidos do banco pelo backend; nenhum objeto de aprovação enviado pelo navegador é aceito.

O painel mostra elegibilidade e disponibilidade separadamente. Briefing elegível não significa que IA, persistência e coordenador estejam configurados. Geração fica bloqueada enquanto houver alterações locais não salvas, versão histórica, histórico indisponível, falta de configuração ou trabalho ativo.

Ao clicar **Gerar site**, o usuário confirma a solicitação da versão salva. O navegador envia somente `request_id`, `brief_version_id` e `brief_hash` esperados. O servidor autentica usuário/associação, verifica propriedade/RLS e usa `studio_create_generation_job` para admitir atomicamente o trabalho. Uma tentativa UUID criada no servidor adquire o trabalho com `studio_start_generation_job`. Apenas quem adquiriu a tentativa agenda o processamento; solicitações concorrentes não executam duas chamadas.

A API retorna `202` com metadados. O Worker retém o processamento via `ExecutionContext.waitUntil`; o adaptador da Etapa 3 revalida trabalho e briefing, reserva cota durável e chama o provedor configurado. Resultado válido é salvo por `studio_complete_generation_job`, que cria uma versão imutável e conclui o trabalho atomicamente. Nenhum resultado anterior é sobrescrito. Não há chamada automática a `studio_review_site_version` nem aprovação/publicação implícita de site.

O navegador consulta o estado salvo, pausa consultas quando a aba está oculta, evita consultas sobrepostas e reconstrói o acompanhamento ao reabrir/recarregar o projeto. Histórico tem paginação de 20 trabalhos e metadados das versões correspondentes. Nenhum documento, HTML, script ou instrução de IA é renderizado ou executado nesta etapa.

CRM, Discovery, oportunidades, login, recuperação de senha, projetos e versões de briefing continuam utilizando seus fluxos anteriores. Os arquivos de contrato/elegibilidade, SQL e adaptador das Etapas 1–3 foram preservados. Não foi criado novo SQL nesta etapa.

## Endpoints autenticados

Base: `/api/studio/projects/:id/site-generation`.

| Método / caminho                                         | Comportamento                                                                                                                                                                 |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /eligibility?brief_version_id=UUID&brief_hash=HASH` | Relê elegibilidade e retorna somente códigos/mensagens, chaves públicas essenciais ausentes e disponibilidade sanitizada.                                                     |
| `POST /jobs`                                             | Corpo estrito com os três identificadores esperados; admite/adquire/agenda uma única tentativa. `202` para trabalho ativo e `200` para repetição de um trabalho já terminado. |
| `GET /jobs/:jobId`                                       | Estado persistido e metadados da versão resultante, quando existente, limitados ao proprietário/projeto.                                                                      |
| `GET /history?offset=0`                                  | Até 20 trabalhos e respectivas versões; `has_more` permite paginação.                                                                                                         |
| `POST /jobs/:jobId/cancel`                               | Exige `{ "confirm": true }`; encerra trabalho ativo com `cancelled`, usando tentativa/proprietário relidos do banco. Não remove histórico.                                    |

Todos herdam autenticação e associação ativa de `/api/studio/*`. Mutações exigem a origem configurada e JSON, com o limite de corpo existente. Leituras usam cliente com JWT do usuário e RLS, com filtros explícitos adicionais de proprietário/projeto. Não há service role. Respostas têm `Cache-Control: no-store`.

DTOs do navegador excluem `owner_id`, `attempt_id`, `public_information`, fontes privadas, snapshot, prompt, chave, endpoint, modelo e documento gerado. O histórico mostra somente IDs/hash de proveniência, estado, erro enumerado, datas, número e hash da versão. O formulário de briefing existente continua mostrando os campos privados ao seu proprietário autorizado; não houve ampliação dessa permissão.

## Idempotência, falhas e limites

- A mesma chave e os mesmos versão/hash retornam o trabalho já existente. Outra entrada com a mesma chave é recusada. Replay nunca readquire um trabalho ativo nem chama a IA novamente, mesmo se o navegador perdeu a resposta inicial.
- A tentativa do servidor, o índice de um trabalho ativo por projeto e o coordenador durável da Etapa 3 se complementam. Não existe fallback local de cotas nem uma opção HTTP/env para habilitar provedor simulado.
- O frontend mantém a chave após resposta incerta. Primeiro reconcilia pelo histórico; se nenhum trabalho for encontrado, o usuário pode repetir explicitamente a mesma solicitação com a mesma chave. Recarregar não causa POST automático. Uma nova versão exige outra decisão humana.
- A finalização pode repetir **somente a RPC de persistência**, com tentativa e documento idênticos, até duas vezes. Isso trata resposta perdida após commit sem criar duas versões. Nunca repete o modelo.
- Sem confirmação do banco após essas tentativas, não se inventa sucesso nem se sobrescreve o estado como falha: a consulta seguinte é a fonte de verdade. Trabalho ainda ativo pode precisar de encerramento manual. Documento não persistido não possui cache durável para recuperação posterior.
- `waitUntil` não é uma fila durável. O controlador impõe até 20 segundos para o caminho de geração/revalidação e tenta finalizar dentro de uma janela total de 28 segundos, com timeout curto nas RPCs de finalização. Esse teto do fluxo integrado prevalece sobre um timeout maior do adaptador. Interrupção de Worker, indisponibilidade do banco ou expiração/revogação do JWT podem impedir a finalização. Não há lease, heartbeat, reprocessamento automático ou credencial privilegiada para contornar autorização.
- Após dois minutos, trabalhos ainda ativos aparecem como demorados. Consultar não altera o banco. O usuário pode atualizar ou encerrar explicitamente antes de decidir por uma nova solicitação. Trabalhos pendentes admitidos antes de uma interrupção não são executados automaticamente no replay.
- Cancelar não garante interrupção de requisição já recebida pelo provedor e não devolve cota. A RPC impede que uma resposta tardia sobrescreva um trabalho cancelado. Uma nova solicitação após cancelar exige nova confirmação e nova cota.
- Se o briefing mudar durante uma chamada já enviada, a saída pode ser preservada com a versão/hash **originalmente aprovados**, conforme a Etapa 2. Isso não aprova a saída para o briefing novo. Aprovação/publicação futura precisa reler as permissões atuais.

As tabelas existentes permitem seis códigos persistidos: `cancelled`, `timeout`, `provider_unavailable`, `invalid_response`, `brief_changed`, `internal_error`. Falhas de autenticação/rate limit/cota do provedor são agrupadas em `provider_unavailable`; o painel não afirma uma causa mais específica que o histórico consegue provar. Erros brutos, prompts e credenciais não são registrados em logs ou retornados. Não foi alterado o enum SQL para acrescentar detalhes.

Ausência de tabelas/funções (`42P01`, `42883`, `PGRST202`, `PGRST205`) retorna `migration_missing`, sem execução automática de migração. Configuração ausente/inválida, cotas estáticas zeradas, coordenador ausente ou contexto Worker indisponível impedem admissão e são explicados no painel. Presença do binding não é teste de saúde do coordenador; falha em operação bloqueia a geração e usa o estado de erro persistido. Histórico e resultados anteriores continuam consultáveis com IA desativada.

## Como testar localmente sem API real

Requisitos: Node 24, dependências instaladas e Chromium para navegador.

```bash
npm ci
npm run format:check
npm run check
npm test -- tests/studio-generation-api.test.ts
npm run test:e2e -- tests/e2e/studio-generation.spec.ts
npm audit --audit-level=high
```

Se Chromium já estiver instalado, definir `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` para seu caminho. Caso contrário, instalar o browser do Playwright em seu ambiente de teste. Esses testes não usam chaves reais nem fazem geração de IA externa.

- `tests/studio-generation-api.test.ts` exercita Hono, autenticação simulada, RPCs/constraints/RLS **reais em PostgreSQL PGlite temporário**, DTOs, idempotência, concorrência de requisições, isolamento, ausências de configuração/migração, erros, cancelamento, paginação, contexto Worker e respostas perdidas de persistência. O provedor é `MockSiteDocumentProvider`; o cliente PostgREST é uma ponte somente de teste para SQL local. Não é homologação de transporte PostgREST/Supabase hospedado nem concorrência entre servidores PostgreSQL independentes.
- `tests/e2e/studio-generation.spec.ts` exercita confirmação, polling, recarregamento, histórico, responsividade, configuração ausente, campos privados/rascunho, cancelamento, sessão revogada e retry com a mesma chave. Respostas HTTP são simuladas no navegador. Não há backdoor de simulação no aplicativo publicado.
- As suítes anteriores continuam verificando os contratos, adaptador e persistência. Testes de banco aplicam migrações **somente em memória descartável**; nenhuma migração nova/remota é executada pela implementação.

Para abrir a interface normal:

```bash
npm run dev
```

Abrir **http://localhost:5173/studio**. Sem Supabase configurado, o login informa a conexão pendente. Com um ambiente de desenvolvimento **já autorizado/configurado**, abrir um projeto, preencher procedência/verificação/uso público, salvar/revisar e aprovar o briefing. O painel mostra a disponibilidade e explica a ausência de IA, migração ou coordenador; o exemplo mantém `STUDIO_AI_PROVIDER=disabled`, portanto o botão não dispara uma chamada real.

Para observar sucesso/falha sem qualquer API, usar os testes de navegador acima: eles apresentam fixtures sintéticas e simulam os estados. Não habilitar endpoint real, segredo ou recurso Cloudflare para repetir esses testes. Ativação real futura depende da configuração descrita em `docs/STUDIO_AI_ADAPTER.md`, homologação e autorização específicas. Esta entrega não cria binding/migração de Durable Object ou serviço pago, não aplica o SQL da Etapa 2 no Supabase e não faz deploy.

Os limites financeiros do provedor e a veracidade/qualidade comercial do resultado ainda exigem controle externo e revisão humana. Não há prévia, executor, assets, chat, ZIP, GitHub Pages ou publicação; essas funcionalidades permanecem para etapas posteriores autorizadas.
