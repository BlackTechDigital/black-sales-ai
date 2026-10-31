# Persistência de sites — Etapa 2

Implementação na branch `codex/studio-site-persistence`, baseada no Studio existente e nos arquivos da Etapa 1. Os contratos Zod e o helper de elegibilidade da Etapa 1 permanecem intactos. Esta etapa acrescenta somente persistência, operações transacionais de banco, testes e documentação. Não há provedor, chamada de IA, worker, rota HTTP de geração, interface, execução de código, prévia, ZIP ou publicação.

## Migração e dados

Arquivo: `supabase/migrations/202610310004_site_persistence.sql`.

Depende das três migrações anteriores: fundação, descoberta e Studio. Usa as funções existentes `auth.uid()`, `is_active_member()`, `studio_valid_fields()`, `studio_brief_hash()` e `studio_deny_rewrite()`. Não substitui essas funções. Não altera tabelas, políticas, registros ou configurações anteriores. Os únicos `ALTER TABLE` são das quatro tabelas novas.

| Tabela                   | Finalidade e invariantes                                                                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `studio_sites`           | Um site por projeto e usuário; ponteiro para a versão atual, inicialmente nulo.                                                                                       |
| `studio_generation_jobs` | Requisição idempotente, estado, tentativa, versão/hash do briefing aprovado, modo do projeto, cópia somente dos valores públicos e versão anterior do site.           |
| `studio_site_versions`   | Documento estruturado v1, hash calculado no banco, número crescente, versão anterior e vínculo ao trabalho/briefing exatos; um resultado por trabalho.                |
| `studio_site_reviews`    | Histórico imutável de decisões humanas (`approved` ou `changes_requested`), versão/hash exatos, observação limitada, responsável autenticado e chave de idempotência. |

As chaves estrangeiras compostas impedem misturar proprietários, projetos, sites, briefings, trabalhos e versões. A geração referencia tanto a versão/hash quanto o registro de aprovação persistido. Não aceita objeto de aprovação, proprietário ou responsável fornecido pelo cliente. Não há exclusão em cascata nem sobrescrita de documentos anteriores. Referências usam `ON DELETE RESTRICT`.

Todos os horários são definidos pelo banco. O hash do documento utiliza a função existente sobre a representação canônica do JSONB no PostgreSQL; não deve ser recalculado no navegador usando `JSON.stringify()`. As respostas das RPCs incluem os hashes persistidos.

## Autorização e operações

As quatro tabelas têm RLS de leitura: usuário autenticado, associação ativa e propriedade do projeto. `anon` não tem acesso. `authenticated` recebe apenas `SELECT`, mesmo em instalações com permissões padrão permissivas. Gravações diretas são revogadas.

As cinco RPCs de gravação são `SECURITY DEFINER`, com `search_path` vazio, nomes qualificados e verificações explícitas de usuário/associação/propriedade. Apenas essas RPCs recebem `EXECUTE` para `authenticated`; helpers são privados. Não há service role nem credenciais novas. As operações seguem o mesmo padrão do Studio atual e deverão ser chamadas pela futura integração de backend com o JWT do usuário. Como as RPCs do Studio atual, também são acessíveis ao proprietário via API autenticada do Supabase; seu conteúdo não prova que um provedor de IA foi executado.

1. `studio_create_generation_job(p_project_id, p_brief_version_id, p_brief_hash, p_request_id)` bloqueia o projeto, relê a versão atual e a aprovação e valida elegibilidade. Os cinco campos essenciais precisam ter conteúdo, origem, verificação e uso público autorizado. Valores fictícios são permitidos somente em demonstrações. A cópia pública exclui notas criativas, fontes, snapshot da oportunidade e todos os campos privados. A chave UUID é única por usuário/projeto. Repetir a mesma chave e entrada devolve o mesmo trabalho; reutilizá-la com outra entrada falha. No máximo um trabalho `pending`/`processing` por projeto, garantido também por índice único parcial.
2. `studio_start_generation_job(p_job_id, p_attempt_id)` muda `pending` para `processing`, exigindo briefing ainda atual e identificador UUID da tentativa. A mesma tentativa pode repetir a aquisição; outra tentativa não pode assumir esse trabalho.
3. `studio_complete_generation_job(p_job_id, p_attempt_id, p_document)` exige a tentativa adquirida e documento estruturado válido. Em uma transação, acrescenta uma versão, move o ponteiro do site e conclui o trabalho. Repetição com a mesma tentativa e documento retorna a versão existente; outro conteúdo é rejeitado. O nome da empresa precisa coincidir com o contexto público do trabalho.
4. `studio_fail_generation_job(p_job_id, p_attempt_id, p_error_code)` encerra um trabalho pendente ou processando. Para pendentes a tentativa é nula. Códigos permitidos: `cancelled`, `timeout`, `provider_unavailable`, `invalid_response`, `brief_changed`, `internal_error`. Não aceita erro bruto de provedor, segredo, stack trace ou prompt como erro do trabalho.
5. `studio_review_site_version(p_version_id, p_document_hash, p_decision, p_notes, p_request_id)` registra uma decisão vinculada à versão/hash atuais do site. Aprovar também exige que o briefing ainda seja o atual. A repetição exata de uma revisão retorna o registro anterior, mesmo após outra versão surgir; uma chave existente nunca aprova a versão nova. Alterações exigem outra revisão e outra chave.

As RPCs serializam alterações na ordem **projeto → trabalho → site**, compatível com o bloqueio de projeto do salvamento de briefing existente. Não mantêm transações abertas durante operações externas. Estados terminais não reabrem: uma nova execução exige outra chave e outro trabalho. Triggers também impedem reescrita de versões/revisões, exclusão de trabalhos e alterações da proveniência/tentativa de um trabalho.

Se o briefing mudar antes de iniciar, o trabalho fica pendente e o início falha; o responsável deve encerrá-lo explicitamente com `brief_changed` antes de criar outro. Se mudar durante processamento, o resultado pode ser preservado como histórico vinculado ao briefing original, mas não pode receber uma nova aprovação enquanto estiver desatualizado. Uma revisão antiga nunca constitui autorização permanente de publicação: uma etapa futura deverá conferir novamente versão, hash, briefing e permissões de uso no momento da publicação.

Erros de validação usam SQLSTATE `22023`, indisponibilidade/permissão `42501` e conflitos de estado/versão `40001`. Uma futura camada HTTP deve traduzi-los em mensagens sanitizadas; `40001` não autoriza repetir automaticamente uma operação com outra versão ou chave.

## Validação e limites

O banco valida o documento v1: chaves estritas, identidade, cinco tipos de seção, textos simples, opções visuais enumeradas, cores, links internos existentes, página `/`, unicidade de IDs/caminhos e limites de páginas/seções/cards/botões/parágrafos. Limita JSON compacto a 128 KiB e usa contagem de caracteres Unicode compatível com o Zod instalado. Rejeita HTML, código e protocolos executáveis.

A futura integração deve **primeiro** validar e normalizar a saída com `siteDocumentSchema`/`parseSiteDocumentText` no backend e **depois** usar a RPC. O SQL é uma segunda barreira, não um substituto do contrato compartilhado. O parser SQL de HTTPS é deliberadamente conservador: aceita hosts ASCII/punycode compatíveis com o contrato, mas rejeita algumas representações que `new URL()` normalizaria, como domínio Unicode, hostname percent-encoded e porta escrita `:0443`. A Etapa 1 não foi alterada; prefira URLs canônicas ASCII. Ambos rejeitam hosts locais/IPs literais, portas alternativas, credenciais e cabeçalhos extras em `mailto`.

Não há acesso de rede ou execução do documento. Validação estrutural não comprova veracidade, ausência de informação privada em texto livre, licença, qualidade visual ou que todos os textos vieram do contexto público. O snapshot de entrada respeita permissões por campo, mas uma saída arbitrária ainda exige revisão humana e validação de conteúdo antes de uso público. Domínios válidos ainda exigirão proteção própria contra SSRF/DNS/redirecionamentos caso uma integração futura faça downloads.

## Testes locais descartáveis

Pré-requisito geral: Node 24 e `npm ci`. Não configurar Supabase nem credenciais remotas para esses testes.

```bash
npm run format:check
npm run check
npm run test:db:concurrency
npm run test:e2e
```

- `tests/site-persistence-database.test.ts`: PostgreSQL em memória com PGlite; aplica as migrações anteriores, cria dados sintéticos anteriores à migração nova e compara integralmente seu conteúdo após aplicá-la. Testa RLS, associação inativa, outro usuário, acesso anônimo, grants permissivos, integridade referencial, elegibilidade, idempotência, estados, versões/revisões imutáveis e validação do documento contra o contrato da Etapa 1. Não usa banco externo.
- `scripts/test-site-persistence-concurrency.mjs`: sete disputas reais entre sessões independentes em PostgreSQL 17. Comprova a espera por bloqueio usando `pg_stat_activity`, antes de liberar a primeira transação. Cobre admissão duplicada/concorrente, aquisição, conclusão repetida/divergente, cancelamento versus conclusão e mudança de briefing versus admissão.
- O segundo comando de banco exige Docker Linux no socket local `/var/run/docker.sock` e acesso inicial à imagem oficial fixada por digest. Cria exclusivamente um container próprio, sem rede, portas, volumes persistentes ou mounts do host; os dados ficam em tmpfs. A autenticação trust existe somente nesse ambiente isolado. Ignora endpoints Docker herdados e nunca consulta `DATABASE_URL`, `PGHOST` ou credenciais Supabase. Remove o container no término ou sinal de interrupção. Um encerramento forçado do processo/host pode exigir remoção manual do container de teste identificado por `black-sales-ai.test=site-persistence`.
- O workflow de revisão executa a suíte de concorrência adicionalmente às verificações existentes, sem conexão remota ou etapa de implantação.

Fixtures são explicitamente sintéticas e nunca inseridas na aplicação. A simulação de Auth dos testes não substitui uma validação futura de homologação com JWTs reais do Supabase.

## Aplicação futura segura — somente com autorização

Nenhuma migração remota foi executada nesta entrega. Para uma aplicação futura:

1. Revisar o SQL e o diff, executar todas as verificações e confirmar que as três migrações anteriores estão registradas no ambiente alvo. Confirmar a ausência de objetos `studio_generation_*`/`studio_site_*` desta etapa e de migração parcialmente aplicada; não apagar objetos para contornar colisões.
2. Fazer backup verificado dos dados e metadados, confirmar o procedimento de restauração e obter autorização específica para o ambiente. Revisar defaults de privilégios, papéis `anon`/`authenticated`, proprietário das funções e versão PostgreSQL na homologação.
3. Aplicar **somente a nova migração**, primeiro em homologação descartável ou restaurada de backup. O arquivo contém `BEGIN`/`COMMIT`; qualquer erro deve abortar a transação completa. Não usar reset, apagar tabelas, reaplicar migrações antigas ou contornar erro com `IF NOT EXISTS`.
4. Conferir RLS/grants e testar com dois usuários ativos, um inativo e anônimo, via API Supabase real. Validar também CRM, descoberta, oportunidades, projetos, briefing e recuperação de senha. Confirmar conteúdo/quantidade dos dados anteriores.
5. Apenas após revisão desses resultados, planejar separadamente uma janela e autorização para o ambiente definitivo. Em caso de falha, interromper a aplicação e diagnosticar; não remover tabelas que já contenham histórico. Preferir correção aditiva revisada. Não há script automático de rollback destrutivo.

## Pendências para etapas posteriores

Não há execução automática de trabalhos, lease/heartbeat, recuperação de trabalhos abandonados, rate limit global, orçamento/cotas, retenção/arquivamento, cancelamento de chamada de provedor ou observabilidade operacional. O limite de um trabalho ativo é por projeto, não por usuário nem custo. Um trabalho travado exige encerramento explícito e nova requisição. O crescimento dos documentos/histórico será cumulativo, com custos de armazenamento conforme o uso futuro do PostgreSQL.

Não há seleção de provedor, IA local/remota, sandbox de código, renderer, assets, prévia, chat, exportação ou deploy. A futura Etapa 3 precisa de autorização; não é iniciada por esta entrega.
