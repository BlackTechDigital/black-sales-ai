# Exportação de sites revisados — Etapa 6

A exportação usa somente o documento estruturado e validado da versão salva. Não chama IA, executa código de modelos, publica sites, contrata serviços ou aplica migrações. CRM, Discovery, briefings e versões existentes permanecem preservados.

## Fluxo e autorização

1. Um membro autenticado e ativo abre seu projeto no Studio e seleciona uma versão na prévia.
2. O backend recarrega projeto, site e versão por proprietário com as políticas RLS existentes. Valida o documento e seu hash persistido; o hash JSONB original não é recalculado com `JSON.stringify`.
3. A prévia e o pacote compartilham `renderSiteVisual`. O SHA-256 de `[head, body, css]` identifica o resultado visual. A API de prévia ganhou o campo opcional `visual_hash`, mantendo compatibilidade com clientes antigos; revisão/exportação exigem esse campo e sua correspondência. O iframe também recebe o fingerprint esperado na URL e o backend rejeita divergências. Nenhum contrato de documento da Etapa 1 foi alterado.
4. **Aprovar o briefing não aprova o site.** No painel abaixo da prévia, o usuário abre a revisão da versão exata e confirma que conferiu seus textos e autorizou uso público, sem segredos, informações privadas ou observações internas.
5. O servidor exige que o briefing original continue sendo a versão atual, aprovada, com o mesmo hash e os campos públicos essenciais autorizados. Reutiliza a elegibilidade das etapas anteriores; não confia em aprovações declaradas pelo navegador.
6. A revisão é inserida pela RPC existente `studio_review_site_version`, com usuário/horário atribuídos pelo banco e chave idempotente. A nota controlada `export-review-v1:studio-static-v1:<artifact_sha256>` vincula a decisão aos arquivos exatos. Notas livres ou aprovações genéricas anteriores não autorizam exportação. A decisão mais recente prevalece.
7. Ao baixar, o servidor confere novamente documento, fingerprint, hash do pacote, revisão e permissões, inclusive uma segunda consulta após construir o ZIP. O navegador verifica cabeçalhos, tamanho e SHA-256 dos bytes antes de iniciar o download. Fechar/trocar a prévia cancela downloads pendentes.

A autorização é verificada no momento da solicitação: uma decisão posterior à última consulta não consegue retirar bytes já enviados. Revogações futuras também não retiram cópias já baixadas. Não existe aprovação permanente ou publicação implícita.

## Persistência existente, sem migração nova

Esta etapa usa as tabelas/RPCs da migração local `202610310004_site_persistence.sql`, sem modificá-la:

- `studio_sites` e `studio_site_versions`: fonte imutável do documento e da procedência;
- `studio_site_reviews`: decisões imutáveis por versão/hash, isoladas por proprietário e associação ativa;
- `studio_review_site_version(...)`: revisão transacional, idempotência e bloqueios existentes.

Não há tabela de ZIPs nem armazenamento externo: o pacote é reconstruído deterministicamente em memória. Hashes de revisão e manifesto identificam o pacote, sem salvar arquivos duplicados. Nenhum dado anterior é sobrescrito.

A RPC atual permite **novas decisões apenas para a versão atual do site**. Versões antigas já revisadas para o mesmo pacote podem ser baixadas enquanto o briefing original ainda for o atual e autorizado. Uma versão antiga sem revisão compatível não pode receber uma nova aprovação nesta etapa. Da mesma forma, a interface só permite solicitar ajustes na versão atual; para bloquear todas as exportações, o administrador pode desabilitar o recurso, e mudanças nas permissões/versão do briefing bloqueiam versões antigas. Novos fluxos de revogação histórica ou aprovação de versões antigas exigem evolução explícita do contrato transacional.

## API autenticada

Base: `/api/studio/projects/:projectId/site-preview/versions/:versionId/export`.

| Método | Caminho                          | Contrato                                                                                                                                                                                                 |
| ------ | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/status?document_hash=<sha256>` | Disponibilidade, fingerprint visual, hash do pacote e decisão resumida; sem documento bruto, notas ou identidade do revisor.                                                                             |
| POST   | `/reviews`                       | `document_hash`, `visual_hash`, `artifact_hash`, `request_id` UUID, `decision` (`approved` ou `changes_requested`), `confirm_review: true`, `confirm_public_use` (obrigatoriamente `true` para aprovar). |
| POST   | base                             | `document_hash`, `visual_hash`, `artifact_hash`, `review_id`, `confirm: true`; retorna `application/zip` e hashes nos cabeçalhos.                                                                        |

Os endpoints reutilizam sessão HttpOnly, proteção de origem, validação Zod estrita, limite de corpo, associação ativa e RLS. Não aceitam código, nomes de arquivos ou aprovação fornecida pelo frontend. Migração ausente, recurso desativado, revisão divergente, documento inválido e briefing alterado geram mensagens controladas. Não há chamadas a provedores ou exigência de coordenador de cotas para exportar uma versão existente.

## Conteúdo e reprodução

O ZIP contém exatamente nove caminhos fixos:

```text
.node-version
README.md
index.html
manifest.json
package-lock.json
package.json
scripts/serve.mjs
scripts/verify.mjs
styles.css
```

O site entregue é o código-fonte HTML/CSS estático completo, sem etapa de compilação e sem JavaScript no navegador. Os dois scripts Node são ferramentas locais fixas, escritas pela aplicação. Não há dependências de terceiros; Node **24.19.0**, npm **11.9.0** e lockfile estão fixados. Não é necessário instalar pacotes. Não são incluídos React, Vite ou ferramentas de geração, pois não são necessários para executar este documento estático.

O corpo, cabeçalho e CSS são os mesmos da prévia. Só muda a entrega dos estilos: nonce/CSP do iframe na prévia e arquivo CSS local com SRI no ZIP. Páginas usam fragmentos e CSS. Como na prévia, links externos e contatos permanecem inativos; imagens, fontes remotas, scripts, iframes e requisições externas não são emitidos. Não há HTML, CSS ou JavaScript arbitrário da IA. Ativar links/assets é trabalho posterior com revisão própria.

O JSON bruto não é exportado: destinos externos não mostrados, metadados de geração, snapshots, observações, contexto privado e informações do provedor não são serializados. O manifesto inclui apenas ID/número/hash da versão, perfil, fingerprint visual, runtime e inventário de tamanhos/hashes. O usuário deve conferir o conteúdo público antes de aprovar. Há bloqueio adicional para credenciais conhecidas do servidor e padrões comuns de tokens no texto, sem alegação de detectar qualquer segredo desconhecido ou validar automaticamente veracidade/licenças.

As entradas são UTF-8, ordenadas por caminho, sem compressão, com data ZIP fixa em 1980-01-01, permissões regulares `0644`, sem comentários, extras, symlinks ou bits executáveis. Há allowlist de caminhos, limite de **1 MiB por arquivo** e **2 MiB por ZIP**. Nomes de empresas não são usados como caminhos. `../`, caminhos absolutos, caracteres de controle e nomes fora da lista são recusados.

Cada arquivo, exceto o próprio manifesto, possui SHA-256 e tamanho no manifesto. `artifact_sha256` cobre o descritor JSON canônico sem incluir a si mesmo; o SHA-256 dos bytes do ZIP segue no cabeçalho de download e é conferido pelo navegador. O manifesto não é assinatura digital e não autentica um pacote de terceiros que reescreveram também os hashes. Mudanças no renderizador ou nas ferramentas alteram o pacote e invalidam sua revisão anterior. Guardar o mesmo documento e a mesma implementação produz os mesmos bytes; não se promete reconstruir pacotes de renderizadores antigos após mudanças futuras sem manter aquela implementação.

## Testar sem API paga

Os testes usam documentos explicitamente sintéticos e banco PostgreSQL/WASM temporário, em memória. Não criam empresas reais nem semeiam dados de produção.

```bash
npm run typecheck
npm test -- tests/studio-site-artifact.test.ts tests/studio-export-api.test.ts
npm run build
npm run test:e2e -- tests/e2e/studio-export.spec.ts
```

Os testes de navegador servem o build sob CSP restritiva e simulam a API. Realizam revisão explícita, baixam bytes reais de ZIP, extraem em pasta descartável de saída do Playwright, executam o verificador exportado e abrem o site em loopback `127.0.0.1:4173`, encerrando esse processo ao final. Testam integridade, responsividade, navegação, revisão revogada, fingerprint divergente e cancelamento de download. Precisam de Python, Chromium, Node fixado e porta 4173 livre. Nenhum teste chama IA ou Supabase remoto.

Para ver o fluxo interativamente sem configurar Supabase nem IA:

```bash
npm run build
npm run test:e2e -- tests/e2e/studio-export.spec.ts --project=desktop --headed
```

Os ZIPs e sites extraídos dos testes ficam em `test-results/`, que já está fora do controle de versão. `test-results` é regenerado pelo Playwright; copie o ZIP desejado para uma pasta própria antes de rodar os testes novamente.

Em um ambiente local **já autorizado**, com as tabelas existentes e versões salvas, defina apenas `STUDIO_SITE_EXPORT_ENABLED=true` no arquivo local `.dev.vars` (não em variáveis `VITE_`), mantenha `STUDIO_AI_PROVIDER=disabled` e rode `npm run dev`. Abra `http://localhost:5173/studio`, entre, selecione projeto/versão, confira desktop/tablet/celular, revise e baixe. Não execute migrações remotas para experimentar este fluxo; use os testes simulados se a persistência ainda não estiver disponível.

Após extrair um ZIP em uma pasta nova:

```bash
node --version # v24.19.0
node scripts/verify.mjs
node scripts/serve.mjs
```

Abra **http://127.0.0.1:4173**, encerre com Ctrl+C. Alternativas: `npm run verify` e `npm start`. Não é necessário `npm install`, `npm ci`, chave ou acesso à internet. Não abra por `file://`, pois a CSP foi preparada para HTTP local. O servidor verifica inventário/hashes e mantém os arquivos em memória; atende somente HTML/CSS, GET/HEAD, Host permitido e loopback. Não atende manifesto, scripts, credenciais ou arquivos arbitrários, e não é servidor de produção. O verificador recusa arquivos extras e symlinks; não altere o pacote antes de conferir sua integridade.

## Ativação futura e limites

`STUDIO_SITE_EXPORT_ENABLED` começa **false** e deve ser habilitada somente após revisão/homologação. Não é credencial nem configuração de cobrança. Uma ativação futura deve conferir autorização de acesso, tabelas/RPCs existentes, CSP, capacidade/tempo de CPU do Worker, runtime local e políticas de retenção/revisão. A publicação da aplicação exige autorização separada; nada nesta etapa realiza deploy ou configuração remota.

Ficam fora do escopo publicação/GitHub Pages, assets/licenciamento de imagens, React/TypeScript exportado, edição do código, executor, rotas de SEO, assinatura digital, armazenamento permanente de ZIPs e melhorias de aprovação histórica. Transporte Supabase/PostgREST real e execução em um Worker publicado ainda precisam de homologação autorizada. O build local e a simulação não substituem essa verificação.

## Arquivos desta etapa

Criados:

- `shared/studio-export.ts`: contratos de intenção de revisão, download e disponibilidade.
- `server/studio-digests.ts`, `server/studio-site-artifact.ts`, `server/studio-zip.ts`, `server/studio-export-tools.ts`: hashes, artefato, arquivo ZIP e ferramentas locais controladas.
- `server/studio-export.ts`: autorização, revisão e download autenticados.
- `src/studio/SiteExportPanel.tsx`, `src/studio/export-api.ts`: revisão explícita e download verificado/cancelável.
- `tests/studio-site-artifact.test.ts`, `tests/studio-export-api.test.ts`, `tests/e2e/studio-export.spec.ts`: reprodução, segurança, permissões e fluxo no navegador.
- `docs/STUDIO_SITE_EXPORT.md`: operação, ativação e limites.

Modificados nesta etapa:

- `server/index.ts`, `server/types.ts`: registro das rotas, erros controlados e flag opcional.
- `server/studio-preview-renderer.ts`, `server/studio-preview.ts`, `shared/studio-preview.ts`: renderização visual compartilhada e fingerprint compatível da prévia.
- `src/studio/SitePreviewPanel.tsx`, `src/studio/preview-api.ts`, `src/styles.css`: integração no painel e layout responsivo.
- `tests/fixtures/studio-generation-db.ts`, `tests/studio-preview-api.test.ts`, `tests/e2e/studio-preview.spec.ts`: suporte à RPC real de revisão no banco descartável e compatibilidade com a integração de prévia.
- `.dev.vars.example`, `.github/workflows/review.yml`, `scripts/check-client-boundary.mjs`, `README.md`: flag desativada, runtime fixado no CI, verificação da separação frontend/backend e documentação.

O workspace já continha alterações das Etapas 1–5 antes desta missão. Elas foram preservadas e não devem ser confundidas com os arquivos de autoria desta etapa. Não há migração ou dependência nova na Etapa 6.
