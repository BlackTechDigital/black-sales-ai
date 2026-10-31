# Adaptador de IA — Etapa 3

Branch: `codex/studio-ai-adapter`. Esta etapa entrega uma biblioteca de backend para produzir **documentos estruturados**, não código executável. Nenhuma interface, rota pública, fila/consumer, prévia, publicação ou fluxo automático foi registrado. Não houve chamada real de IA, configuração de credenciais, ativação de serviço, deploy ou alteração de banco remoto. Os contratos e a migração das Etapas 1 e 2 permanecem intactos.

## Organização

| Arquivo                                 | Responsabilidade                                                                                                             |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `server/studio-ai/config.ts`            | Configuração exclusiva dos bindings do Worker, endpoint canônico confiável, allowlist explícita de modelos, chave e limites. |
| `server/studio-ai/generate.ts`          | Autorização, releitura de trabalho/briefing, reserva durável, timeout/cancelamento, validação Zod e resultado sanitizado.    |
| `server/studio-ai/prompt.ts`            | Instruções internas, serialização dos dados públicos não confiáveis e JSON Schema derivado do contrato existente.            |
| `server/studio-ai/provider.ts`          | Interface extensível de provedores de documentos.                                                                            |
| `server/studio-ai/openai-compatible.ts` | Transporte Chat Completions compatível com OpenAI, resposta estruturada e leitura limitada em bytes.                         |
| `server/studio-ai/mock-provider.ts`     | Provedor explícito para fixtures de teste; sem rede, chave ou fallback.                                                      |
| `server/studio-ai/usage-guard.ts`       | Reserva transacional de cotas e deduplicação em Durable Object; cliente interno que bloqueia em caso de falha.               |
| `server/studio-ai/errors.ts`            | Códigos e mensagens fixas, sem erros brutos, conteúdo, credenciais ou prompts.                                               |

`server/types.ts` declara os bindings opcionais. `server/index.ts` exporta somente a classe do coordenador para futura configuração; não chama o adaptador nem cria rotas. `wrangler.jsonc` não foi modificado: **não existe binding ou migração de Durable Object habilitado nesta entrega**. O exemplo `.dev.vars.example` mantém `STUDIO_AI_PROVIDER=disabled` e não contém chave ou endpoint de IA.

O antigo `shared/studio-ai.ts` continua como contrato futuro do Studio para conceitos/código/patches. Não foi reutilizado para fingir geração de código: o adaptador desta etapa possui contrato próprio, somente no backend, para `SiteDocument` v1.

## Contrato interno e integração futura

O ponto de entrada é `generateStudioSite(context, { job_id }, workerEnv, dependencies?)`. `context` deve vir do middleware de autenticação existente: usuário verificado e cliente Supabase com JWT desse usuário, sem service role. `workerEnv` deve ser o binding confiável do Worker, nunca JSON do navegador. Dependências opcionais destinam-se a testes/controladores internos confiáveis; não são opções HTTP.

A única entrada operacional aceita é o UUID de um trabalho existente. Não são aceitos modelo, endpoint, chave, prompt, dados públicos, proprietário, versão ou objeto de aprovação fornecidos pelo solicitante.

1. Exige usuário e banco autenticados; lê o trabalho por ID **e proprietário**, sob RLS. O trabalho da Etapa 2 precisa estar `processing`, com `attempt_id` persistido válido. Não cria, adquire nem conclui trabalhos nesta etapa.
2. Usa `getSiteGenerationEligibility` da Etapa 1 para reler o briefing atual, a aprovação exata e as permissões por campo. Compara modo e snapshot público do trabalho com o contexto autorizado. Não lê dados de CRM/Discovery para completar fatos ausentes.
3. Prepara uma mensagem `system` fixa e uma mensagem `user` com JSON de dados públicos não confiáveis. Fontes, notas privadas, snapshot da oportunidade, identificadores de usuários/projeto e credenciais não entram no prompt. Nenhuma URL do briefing é acessada.
4. Verifica o orçamento de entrada e reserva cota/deduplicação em um único coordenador durável compartilhado pelo namespace do Worker. Sem binding válido, a operação é bloqueada, sem fallback para memória local.
5. Relê novamente trabalho e elegibilidade **depois** da reserva, imediatamente antes de chamar o provedor. Cancelamento, associação revogada, mudança de briefing ou tentativa durante a espera impedem a chamada. Uma reserva já consumida não é devolvida.
6. Faz no máximo uma tentativa de transporte, com endpoint/modelo fixos no servidor, sem redirecionamentos, streaming de geração, ferramentas, retries, negociação automática de formato ou fallback.
7. Exige um único resultado `assistant`, `finish_reason=stop`, sem recusa/tool calls; limita a resposta em bytes e valida o texto JSON com `parseSiteDocumentText`/schemas Zod existentes. Documento inválido, empresa diferente e material interno reconhecível são rejeitados sem retornar o conteúdo bruto.

Sucesso retorna somente documento validado, IDs/hash de proveniência, uso de tokens opcional e `requiresHumanReview: true`. Falha retorna somente `ok: false`, código e mensagem fixa. Não são retornados chave, endpoint, modelo configurado, prompt interno ou resposta bruta.

Não há escrita nas tabelas da Etapa 2 pelo adaptador. O futuro controlador deverá admitir/adquirir o trabalho via RPC, chamar esta biblioteca, registrar sucesso/falha e persistir o documento via RPC, revalidando o estado. Deve exigir revisão humana antes de qualquer uso público. Timeout não comprova que o provedor deixou de processar ou cobrar a requisição.

## Configuração futura necessária

Nada abaixo foi habilitado. Antes de uma integração futura, revisar provedor, preços/cotas, política de dados e suporte real a JSON Schema. Não se presume acesso gratuito a nenhum modelo.

| Binding do Worker                | Padrão / regra                                                                                                                                                                                                                                                       |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STUDIO_AI_PROVIDER`             | Ausente ou `disabled`: sem chamadas. Único valor externo aceito: `openai-compatible`. `mock` não é uma opção de produção.                                                                                                                                            |
| `STUDIO_AI_ENDPOINT`             | URL completa HTTPS **canônica** terminada em `/chat/completions`, por exemplo o caminho `/v1/chat/completions` no host do provedor escolhido. Sem valor padrão, usuário/senha, query, fragmento, porta alternativa, IP literal ou sufixo local. Não vem do briefing. |
| `STUDIO_AI_MODEL`                | Identificador escolhido explicitamente pelo operador, sem valor padrão.                                                                                                                                                                                              |
| `STUDIO_AI_ALLOWED_MODELS`       | Array JSON de 1–20 IDs permitidos. O modelo escolhido precisa pertencer ao array. Se a resposta informa um modelo resolvido/versionado, ele também precisa estar na allowlist.                                                                                       |
| `STUDIO_AI_API_KEY`              | Segredo protegido do Worker; obrigatório apenas para configuração externa ativa. Nunca `VITE_*`, arquivo versionado, log ou prompt. Não foi criada chave nesta etapa.                                                                                                |
| `STUDIO_AI_TOKEN_PARAMETER`      | `max_completion_tokens` por padrão; `max_tokens` somente se selecionado explicitamente para um endpoint compatível. Não há tentativa automática alternativa.                                                                                                         |
| `STUDIO_AI_TIMEOUT_MS`           | 20.000 por padrão; configurável entre 1.000 e 60.000 ms. Abrange reserva, revalidação e transporte/leitura da resposta.                                                                                                                                              |
| `STUDIO_AI_MAX_INPUT_TOKENS`     | 16.000 por padrão, máximo 64.000; mínimo configurável 1.000. Verificação conservadora por bytes + margem, sem tokenizer específico.                                                                                                                                  |
| `STUDIO_AI_MAX_OUTPUT_TOKENS`    | 4.096 por padrão; configurável entre 256 e 8.192. Enviado ao provedor como limite explícito.                                                                                                                                                                         |
| `STUDIO_AI_USER_REQUESTS_DAY`    | Zero por padrão; máximo 1.000.                                                                                                                                                                                                                                       |
| `STUDIO_AI_GLOBAL_REQUESTS_DAY`  | Zero por padrão; máximo 10.000. Compartilhado pelo namespace do coordenador.                                                                                                                                                                                         |
| `STUDIO_AI_USER_TOKENS_DAY`      | Zero por padrão; máximo 10.000.000.                                                                                                                                                                                                                                  |
| `STUDIO_AI_GLOBAL_TOKENS_DAY`    | Zero por padrão; máximo 100.000.000.                                                                                                                                                                                                                                 |
| `STUDIO_AI_USER_REQUESTS_MINUTE` | Zero por padrão; máximo 20.                                                                                                                                                                                                                                          |
| `STUDIO_AI_USAGE_GUARD`          | Binding de Durable Object para `StudioAIUsageGuard`. Ausente nesta entrega; ausência/falha bloqueia chamadas externas.                                                                                                                                               |

Valores numéricos devem ser inteiros decimais canônicos; negativos, expoentes, frações e limites acima dos máximos são rejeitados. Todas as cotas necessárias devem ser definidas explicitamente acima de zero para permitir uso.

Um binding futuro do coordenador exigirá revisão da configuração Cloudflare e de uma migração própria de classe SQLite. **Não foi adicionada nem executada essa configuração/migração.** Exemplo apenas documental, para uma implantação futura autorizada:

```json
{
  "durable_objects": {
    "bindings": [
      { "name": "STUDIO_AI_USAGE_GUARD", "class_name": "StudioAIUsageGuard" }
    ]
  },
  "migrations": [
    {
      "tag": "studio-ai-usage-v1",
      "new_sqlite_classes": ["StudioAIUsageGuard"]
    }
  ]
}
```

Verificar plano, disponibilidade e custos do Durable Object/Worker na conta antes de ativar. Namespaces distintos não compartilham orçamento; não trate essas cotas como teto financeiro de toda a conta do provedor. Configurar também limites financeiros e de uso no próprio provedor quando disponíveis. Nenhum serviço pago foi configurado.

## Cotas e prevenção de duplicação

O coordenador usa uma transação para reservar simultaneamente contagens diárias globais/por usuário, tokens diários e contagem por minuto por usuário. Dias são janelas UTC e minutos são janelas fixas, definidos pelo relógio do servidor. Chaves de trabalho e usuário usam SHA-256 com prefixos de domínio; são identificadores pseudonimizados, não prova de anonimização.

Cada trabalho reserva o orçamento **inteiro** `maxInputTokens + maxOutputTokens`, independentemente do uso informado. Com os padrões, são 20.096 tokens reservados por chamada. Erros, respostas inválidas, cancelamentos e timeout não reembolsam a reserva nem liberam o mesmo trabalho para nova chamada. Isso evita repetir uma requisição que pode já ter sido cobrada. Nova tentativa precisa de outro trabalho autorizado e nova cota, por decisão explícita do controlador futuro.

A chave de trabalho permanece após troca de dia, reinício ou falha de Worker. O coordenador não armazena prompts, documento, resposta ou credenciais; armazena apenas chaves pseudonimizadas, horário, contagens e orçamento reservado. Não há cache de documentos nem reapresentação automática de resultado: uma chamada duplicada retorna `duplicate_request`; o futuro controlador deve consultar a versão persistida da Etapa 2 quando aplicável.

Não há garantia de execução externa exatamente uma vez: uma falha após a reserva e antes do envio pode consumir cota sem gerar resultado. A política favorece **no máximo uma tentativa do aplicativo por trabalho**, com bloqueio de repetições ambíguas. Não existe fallback em memória. Manter o mesmo namespace/nome do coordenador é necessário para preservar limites e idempotência entre instâncias.

## Resposta estruturada e limites de segurança

O JSON Schema do transporte é derivado do Zod da Etapa 1. Para atender APIs de Structured Outputs estritas sem introduzir `null` incompatível, a solicitação omite propriedades **opcionais** do schema de transporte: por exemplo, tagline, eyebrow, intro e body opcional de CTA/contato. Isso gera um subconjunto válido do contrato existente; os schemas compartilhados não foram alterados. Campos obrigatórios e refinamentos entre páginas/seções continuam sendo validados pelo Zod no retorno. Não há relaxamento para JSON livre se o endpoint não aceitar esse schema.

O documento continua limitado a 128 KiB; o envelope HTTP aceita até `6 × 128 KiB + 16 KiB` para acomodar escapes JSON. `Content-Length` e bytes realmente recebidos são limitados; UTF-8 inválido, JSON truncado, recusas, ferramentas e saída cortada por limite são rejeitados. Requisições não seguem redirecionamentos e não enviam cookies. Falhas HTTP e exceções são sanitizadas, sem logs de conteúdo.

O limite de entrada estima tokens conservadoramente a partir de bytes da mensagem/schema mais margem. Não é um tokenizer de cada modelo. Uso reportado acima dos limites configurados é rejeitado, mas isso não desfaz eventual consumo externo; preços e faturamento dependem do provedor. A reserva conservadora também pode reduzir uso disponível quando o consumo real é menor.

Separar papéis/JSON reduz a superfície de prompt injection, mas instruções não garantem obediência, veracidade ou sigilo de fragmentos de prompt. A barreira efetiva é: nenhum segredo nas mensagens, nenhum fetch de URLs do briefing, nenhuma ferramenta/execução de código, documento restrito, validação no servidor e revisão humana. São bloqueadas saídas contendo a chave configurada ou o marcador/prompt interno reconhecível, inclusive chave escapada em JSON; isso não constitui detecção universal de conteúdo sensível ou alucinações. Um texto estruturalmente válido ainda pode conter fatos inventados ou conteúdo impróprio.

O formato de URL do banco da Etapa 2 é mais conservador em algumas representações; uma persistência futura ainda poderá rejeitar um documento aceito pelo Zod. Consulte `docs/STUDIO_SITE_PERSISTENCE.md`. Nenhuma validação foi enfraquecida nesta etapa. Revogação/cancelamento **durante** uma chamada já enviada não garante cancelamento no provedor; o controlador futuro precisa revalidar antes de persistir/aprovar/publicar.

O endpoint é uma decisão confiável de servidor e nunca usa URLs do solicitante. Bloqueio sintático de IP/sufixos locais não comprova o destino resolvido por DNS: o operador precisa escolher domínio de provedor confiável e políticas de saída adequadas. Não implementar um proxy genérico de URLs com esse adaptador.

## Testes sem consumo de API

```bash
npm run format:check
npm run check
npm test -- tests/studio-ai-config.test.ts tests/studio-ai-provider.test.ts tests/studio-ai-guard.test.ts tests/studio-ai-generation.test.ts
npm run test:e2e
npm audit --audit-level=high
```

Os testes novos usam fixtures explicitamente sintéticas, transporte simulado e `MockSiteDocumentProvider`. A lógica de transações do coordenador usa um double serializável com rollback e estado compartilhado entre novas instâncias; **não é um teste de Durable Object hospedado nem prova de concorrência no runtime Cloudflare**. Não consulta `DATABASE_URL`, lê segredo real ou faz chamadas ao endpoint configurado. As suítes anteriores mantêm seus testes de banco em memória e API/navegador simulados.

Cobertura: configuração inválida/ausente, modelo não permitido, endpoints inseguros, autenticação de usuário/provedor, autorização e RLS simulados no adaptador, privacidade, injection como dados, formato/schema estritos, limites de bytes/tokens, timeout em fetch/leitura, cancelamento, revisão após espera, cotas, duplicação concorrente, reinício/troca de dia e erros sanitizados. O build passou a bloquear também identificadores de configuração IA e o marcador do prompt no bundle do navegador.

`wrangler deploy --dry-run` pode verificar o bundle local sem publicar; nesta etapa o ponto de entrada exporta o coordenador, mas não ativa sua classe/binding. Antes de autorizar operação externa, ainda é necessário validar o coordenador em runtime Workers, homologar com Supabase/JWT reais e testar um provedor escolhido com orçamento e autorização específicos.

Etapa 4 permanece pendente de autorização: nenhum controlador de geração, execução automática, interface ou integração pública foi iniciado.
