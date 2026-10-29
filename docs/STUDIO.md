# Creative Studio — projetos e briefings versionados

Esta entrega implementa somente a fundação em `/studio`: projetos ligados a oportunidades, projetos de demonstração, formulário de briefing, rascunhos persistidos, revisão de alterações, histórico e aprovação humana de uma versão exata. As funcionalidades do CRM, descoberta e recuperação de senha permanecem na mesma aplicação.

## Testar localmente

1. Use Node.js 24 e a branch `codex/studio-briefings`, baseada em `codex/company-discovery`. Enquanto as anteriores permanecerem abertas, este PR depende da #3, que incorpora as PRs #1 e #2.
2. Preserve seu `.dev.vars` existente. Se ainda não configurou o servidor, siga [SUPABASE.md](SUPABASE.md): `APP_ORIGIN=http://localhost:5173`, `SUPABASE_URL` e `SUPABASE_PUBLISHABLE_KEY` ficam somente no Worker. Não crie variáveis `VITE_*` com essas credenciais.
3. O responsável pelo Supabase de homologação deve revisar e aplicar `supabase/migrations/202610290003_studio.sql` **somente após autorização para esse banco**. Ela depende de `202610290001_foundation.sql` e `202610290002_discovery.sql`. Não reaplique migrações existentes. Esta entrega não executa nem executou SQL remoto; `install`, `dev`, `test` e `build` não aplicam migrações.
4. Execute:

   ```bash
   npm ci
   npm run dev
   ```

5. Entre em **http://localhost:5173** com uma conta liberada em `app_members` e abra **Creative Studio**, ou acesse **http://localhost:5173/studio**.
6. Clique em **Novo projeto** e escolha uma oportunidade ativa do seu usuário. Confira título, snapshot e informações iniciais do briefing. Nome, segmento, cidade e contato vêm da oportunidade, sempre com verificação pendente e uso público desautorizado. Nenhuma classificação de site ou observação do CRM é convertida em afirmação comercial.
7. Alternativamente, escolha **Demonstração / empresa fictícia** e informe o título. O briefing começa vazio. Preencha seu próprio conteúdo e use a classificação **Fictício / demonstração** quando aplicável. Nenhuma empresa fictícia é gerada ou cadastrada no pipeline automaticamente.
8. Preencha os campos desejados, com origem e estado de verificação. Use **Revisar e salvar rascunho**, revise conteúdo e permissões e confirme **Salvar nova versão**. Rascunhos podem estar incompletos. Recarregue a página, selecione novamente o projeto e confira a persistência.
9. Para aprovar, preencha nome, segmento, cidade, serviços e público-alvo. Toda informação preenchida precisa de origem e verificação concluída; projetos vinculados não aceitam a classificação fictícia. Salve e abra **Aprovar versão N**. Revise a confirmação, marque a declaração e confirme. Alterações ainda não salvas e versões históricas não podem receber uma nova aprovação.
10. Altere uma informação ou sua origem: a interface redefine sua verificação e autorização pública. Salve outra versão e confira que ela não herda a aprovação anterior. A versão antiga e sua aprovação permanecem no histórico.
11. No histórico, consulte uma versão anterior em modo de leitura. **Usar como novo rascunho** permite copiar seu conteúdo para uma nova versão atual, mantendo a cadeia existente. A revisão mostra o conteúdo copiado integralmente nesse caso.
12. Verifique que outro usuário não vê esses projetos e que a revogação de `app_members.active` impede leituras, salvamentos e aprovações.

Sem Supabase configurado, a aplicação continua no estado de configuração pendente. Com Supabase configurado e a migração do Studio ausente, suas rotas informam falha de banco; não usam dados demonstrativos como fallback. O cadastro do CRM e a descoberta não passam a depender de tabelas do Studio.

## Campos e procedência

O briefing possui 13 campos: nome da empresa, segmento, cidade, serviços, público-alvo, diferenciais, identidade visual, preferências de cores, estilo do site, referências visuais, funcionalidades desejadas, contatos comerciais e observações do diretor criativo.

Cada campo contém:

| Propriedade    | Regra                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------ |
| `value`        | Texto; empresa até 100 caracteres, cidade/segmento até 80, contatos até 2.000 e demais até 4.000 |
| `source`       | Origem, documento ou declaração do responsável, até 500 caracteres                               |
| `verification` | `pending`, `verified` ou `fictional`; a última é exclusiva de projetos de demonstração           |
| `public_use`   | Autorização declarada por campo, inicialmente `false`                                            |

Confirmar ou classificar como fictício exige conteúdo e origem. Uso público exige conteúdo, origem e verificação concluída. Observações do diretor são sempre internas. Referências visuais são texto; nenhuma URL é acessada, executada ou convertida em HTML.

O formulário redefine verificação e uso público quando conteúdo/origem mudam. Isso auxilia a revisão, mas o estado confirmado continua sendo uma declaração do usuário autenticado, não uma validação automática da empresa. A fonte registrada na descoberta também não é prova de veracidade.

A aprovação do briefing não publica conteúdo nem torna todos os campos públicos. Um briefing pode conter informações privadas aprovadas para planejamento; somente os campos explicitamente autorizados comporão um contexto público em etapas futuras.

## Novas tabelas e migração

`202610290003_studio.sql` é aditiva e transacional. Não contém `DROP`, remoção de dados, alterações nas tabelas existentes ou mudanças no Auth. Se os novos objetos já existirem, a migração falha em vez de sobrescrevê-los.

| Tabela                   | Conteúdo e invariantes                                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `studio_projects`        | Proprietário, título, modo fixo, oportunidade opcional, snapshot da criação, versão atual e chave de idempotência            |
| `studio_brief_versions`  | Campos JSONB validados, número sequencial, antecessora, hash SHA-256 calculado no banco, autor, data e chave de idempotência |
| `studio_brief_approvals` | Versão, hash exato, responsável autenticado e data do servidor; uma aprovação por versão                                     |

Chaves compostas garantem que a versão atual, a antecessora e a aprovação pertençam ao projeto/proprietário corretos. O hash cobre todos os campos, inclusive origem, verificação e autorização pública. Snapshot, tipo e vínculo do projeto não têm rotas de edição nesta etapa. Arquivar ou editar uma oportunidade não altera projetos existentes.

Todos os dados usam RLS por `auth.uid()` e membro ativo. Usuários autenticados recebem somente `SELECT` nas novas tabelas. Não há permissões diretas de inserção, atualização ou exclusão. Versões/aprovações também têm gatilhos que rejeitam reescrita.

As três funções de escrita são **security definer** para oferecer gravações transacionais sem conceder escrita direta nas tabelas. Essa escolha é deliberada: cada função usa `search_path` vazio, objetos qualificados, `auth.uid()`, associação ativa e filtros explícitos de proprietário. Não aceita proprietário/ator fornecidos pelo cliente. O proprietário privilegiado da função não substitui essas verificações. As funções de leitura são security invoker e passam por RLS.

| RPC                     | Comportamento                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `studio_create_project` | Valida oportunidade própria/ativa ou modo demonstração; cria projeto e primeira versão atomicamente; repetição da mesma requisição é idempotente |
| `studio_save_brief`     | Bloqueia o projeto durante a transação, exige a versão atual esperada, valida o JSON completo e anexa uma versão; não reescreve a anterior       |
| `studio_approve_brief`  | Exige versão atual e hash exato, campos obrigatórios e verificação concluída; grava autor/data no servidor e é idempotente                       |
| `studio_list_projects`  | Lista até 50 projetos por página, com estado de aprovação da versão atual                                                                        |
| `studio_project_detail` | Lê a versão atual ou uma versão histórica do mesmo projeto                                                                                       |
| `studio_list_briefs`    | Lista até 50 versões por página, sem incluir o conteúdo completo nos metadados                                                                   |

Requisições repetidas de criação/salvamento usam UUID de idempotência. Reutilizar o UUID com outro conteúdo é rejeitado. Um salvamento baseado em uma versão antiga retorna conflito e preserva o rascunho local. Aprovação de uma versão que deixou de ser atual também retorna conflito. Criar outra versão não revoga nem transfere a aprovação histórica; a versão atual começa sem aprovação.

## API e interface

Todas as rotas usam a autenticação existente, verificação de membro, cookies HttpOnly, validação de origem nas mutações, JSON limitado e respostas `no-store`:

- `GET /api/studio/projects?offset=0`
- `POST /api/studio/projects`
- `GET /api/studio/projects/:id`
- `GET /api/studio/projects/:id/versions?offset=0`
- `GET /api/studio/projects/:id/versions/:version`
- `POST /api/studio/projects/:id/briefs`
- `POST /api/studio/projects/:id/approvals`

As entradas são estritas: proprietário, snapshot, ator, campos desconhecidos e classificações inválidas são rejeitados. O servidor e o banco validam o briefing, inclusive para chamadas diretas ao RPC. A API exige confirmação explícita no corpo da aprovação; o registro identifica a conta responsável, sem afirmar que prova a presença física de uma pessoa.

Rascunhos não salvos ficam somente no estado do componente, sem `localStorage`. Atualizar o briefing, trocar de projeto/versão ou sair pela navegação solicita confirmação quando há alterações. O navegador recebe aviso antes de recarregar/fechar; o comportamento do aviso depende do navegador. Mudanças já persistidas continuam no banco mesmo se a leitura seguinte falhar. Falhas de leitura preservam o editor atual. Salve antes de sair: esta etapa não oferece salvamento automático ou recuperação offline.

## Contratos futuros de IA

`shared/studio-ai.ts` contém apenas interfaces de provedor, solicitação e proposta. Não existe implementação de provedor, registro de modelos, credencial adicional ou chamada de geração.

`publicBriefContext` prepara um subconjunto dos campos autorizados e exige correspondência de versão/hash da aprovação. Exclui observações do diretor, campos privados ou pendentes e conteúdo fictício em projetos vinculados. É um auxiliar de seleção, não um mecanismo independente de autorização: uma integração futura deve recarregar versão, projeto e aprovação do banco sob a sessão verificada antes de usá-lo; objetos enviados pelo navegador não são prova de aprovação.

## Verificações e limites

```bash
npm run format:check
npm run check
npx playwright install chromium
npm run test:e2e
```

Os testes de banco aplicam as três migrações em PostgreSQL WASM/PGlite temporário, em memória, inclusive verificando dados anteriores à migração do Studio. Testes de API simulam o cliente Supabase; navegador simula HTTP em desktop/celular. Fixtures sintéticas existem só nos testes, sem seed de empresas na aplicação. Supabase hospedado, Auth real e transporte PostgREST precisam de homologação autorizada e não foram utilizados para os testes desta entrega.

O backup v1 continua exclusivo do pipeline e não inclui Studio. Backup completo deve incluir as três novas tabelas e seus vínculos com Auth/leads. Não há expurgo ou retenção automática nesta etapa.

Ainda não estão implementados: geração de propostas visuais, sites ou código, executor/sandbox, prévia de site, Ollama, APIs de IA, chat de geração, imagens/upload/Storage, exportação ZIP, publicação GitHub Pages, projetos compartilhados, renomeação/arquivamento/exclusão de projetos ou alteração do snapshot original. A aprovação atual é do briefing, sem autorização de publicação.
