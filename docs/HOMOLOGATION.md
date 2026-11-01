# Homologação privada em Cloudflare Workers

Branch: `codex/private-homologation`, baseada em `codex/studio-http-uuid` no commit `5836e1842a2bd7d1adcbad9469feda4ff98a663f`. Esta preparação não publica a aplicação, cria credenciais, altera Supabase, aplica migrações ou faz merge na main.

## Entrada separada e bloqueio obrigatório

`wrangler.homolog.json` usa o Worker **black-sales-ai-hml**, com entrada em `server/homolog.ts`. A entrada envolve o aplicativo existente com `withHomologAccess`. `wrangler.jsonc` e `server/index.ts` permanecem inalterados. O comando precisa indicar explicitamente a configuração de homologação; o comando padrão continua usando a entrada original, que não tem esta barreira.

A barreira não possui opção para desativar sua autenticação:

- HTTPS obrigatório, inclusive em localhost; HTTP retorna 403 sem solicitar senha.
- Segredo ausente ou fora do formato: 503, sem chamar API, assets, Auth ou banco.
- Basic Auth ausente, inválido ou incorreto: 401 com desafio fixo, sem refletir conteúdo recebido.
- Todos os caminhos e métodos passam pela barreira, incluindo JS/CSS, `/api/session`, login, recuperação, frames, exportação e caminhos inexistentes. `run_worker_first: true` impede bypass pela distribuição de assets.
- A comparação usa HMAC com chave aleatória efêmera e verificação MAC nativa, sem comparação de strings de credenciais e sem fallback criptográfico previsível. Erro criptográfico também bloqueia com 503.
- O cabeçalho Basic, Proxy-Authorization e o binding do segredo são removidos antes de chamar o aplicativo. O backend Supabase continua construindo sua própria autorização com o JWT da sessão.
- Todas as respostas autenticadas recebem `Cache-Control: no-store`, `Pragma: no-cache` e `Vary: Authorization, Cookie`, preservando CSP, cookies e demais cabeçalhos. Respostas bloqueadas também não podem ser armazenadas em cache.
- Não há logging de credenciais, cabeçalhos, URLs ou erros brutos na barreira. Observabilidade do Worker fica desativada; não habilite ferramentas externas que capturem esses dados.

O acesso Basic não cria uma sessão Supabase, libera associação, altera RLS ou ignora Origin/CSRF. Usuários ainda precisam fazer o login existente e estar ativos em `app_members`.

## Segredo exclusivo — configuração futura pelo responsável

Nome do **Secret de runtime**: `HOMOLOG_BASIC_AUTH`.

O valor deverá conter um nome de usuário seguido de dois-pontos e uma senha aleatória exclusiva, sem aspas adicionais ou quebra de linha. O nome aceita 1–64 caracteres ASCII: primeiro alfanumérico, demais alfanuméricos, ponto, hífen ou sublinhado. A senha exige 32–128 caracteres ASCII visíveis sem espaços. Dois-pontos na senha são permitidos; o primeiro separa o usuário.

Gere a senha futuramente em um gerenciador de senhas confiável. Não reutilize credenciais Supabase, não use uma sequência previsível e não coloque o valor no repositório, em variáveis `VITE_*`, variáveis de build, URLs, screenshots, logs ou mensagens. Nenhum valor padrão ou credencial utilizável foi criado nesta etapa. Os valores sintéticos dos testes nunca devem ser usados no ambiente hospedado.

No diálogo nativo do navegador, informe o nome e a senha em campos separados. Eles serão seguidos pelo login normal do Black Sales AI. Basic Auth tem uma credencial compartilhada, sem MFA nem revogação individual; é apropriado somente para homologação restrita. Não equivale ao Cloudflare Access e não torna o hostname invisível na internet. Não há um limitador global adicional de tentativas implementado por esta camada; use senha longa aleatória e monitore cotas/tráfego da conta.

O navegador pode manter a credencial Basic em memória. Sair do Supabase encerra a sessão do aplicativo, mas não garante limpar o cache de HTTP Auth. Use um perfil/janela privada dedicado e encerre sua sessão de navegação ao terminar. Rotacionar o Secret invalida a credencial anterior nas próximas requisições; não apaga conteúdo já carregado no navegador.

## Estado seguro inicial da configuração

| Item                     | Estado preparado                                       |
| ------------------------ | ------------------------------------------------------ |
| Worker                   | `black-sales-ai-hml`, independente do nome de produção |
| Entrada                  | `server/homolog.ts`                                    |
| Assets                   | `dist`, binding `ASSETS`, Worker executado primeiro    |
| `workers_dev`            | `false`                                                |
| `preview_urls`           | `false`                                                |
| Rotas/domínios           | Nenhum cadastrado no arquivo                           |
| Variáveis do painel      | Preservadas com `keep_vars: true`                      |
| IA                       | `STUDIO_AI_PROVIDER=disabled`                          |
| Exportação               | `STUDIO_SITE_EXPORT_ENABLED=false`                     |
| Observabilidade          | Desativada                                             |
| Supabase/Secret Basic    | Sem valores no arquivo                                 |
| Durable Object/migrações | Não configurados                                       |

`workers_dev: false` e ausência de rotas mantêm a preparação sem endereço público padrão. `preview_urls: false` fecha URLs de versões/prévia; não habilite Preview Builds. Confira também rotas/domínios e previews já existentes no painel: um arquivo novo não comprova o estado da conta. Não reutilize um Worker existente com rotas ou finalidade de produção.

## Próximo passo pelo navegador, sem cartão e sem publicar

Antes de enviar esta branch ao GitHub, confira a integração Cloudflare que já estiver conectada: um push pode disparar deploy ou Preview Build automaticamente. Mantenha Preview Builds desativados e o comando de publicação em dry-run, ou desconecte Builds durante a preparação. Sem confirmação dessas condições, preserve a branch somente local; as flags desta configuração não protegem um build que use a configuração original por engano.

1. No GitHub, abra esta branch e confira os arquivos e o commit informado na entrega. Não selecione a main antiga e não aceite autoconfiguração baseada nela.
2. No Cloudflare **Workers & Pages**, use um projeto exclusivo chamado `black-sales-ai-hml`. Não conecte esta configuração a um Worker de produção: Workers Builds pode ajustar o nome de destino a partir do projeto conectado.
3. Se o projeto já existe, entre em **Settings → Build/Builds → Branch control** e selecione `codex/private-homologation`. O campo pode ser chamado **Production branch** mesmo para homologação. Desative **Enable Preview Builds**.
4. Configure raiz do repositório, onde estão `package.json` e a configuração de homologação. Em variáveis de build, fixe `NODE_VERSION=24.19.0`.
5. Como comando de build, use a trava abaixo. Ela falha se o checkout não corresponder à branch preparada:

   ```sh
   test "$WORKERS_CI_BRANCH" = "codex/private-homologation" && npm ci && npm run build
   ```

6. Mantenha o comando de publicação em **validação sem upload**:

   ```sh
   npx wrangler deploy --config wrangler.homolog.json --dry-run
   ```

   Não use o comando padrão sem `--config`; não substitua por `wrangler versions upload` ou `wrangler preview`, que podem enviar código e criar endereços acessíveis. O dry-run valida o pacote, mas não publica uma aplicação para testar pelo navegador.

7. Se o assistente não permitir escolher a branch ou salvar esses comandos sem efetuar publicação real, pare nessa tela. A documentação situa o seletor nas configurações do projeto; não faça um deploy inicial da main ou de Hello World para desbloquear o menu. Não altere a branch padrão do GitHub.

Esta barreira não depende do Zero Trust nem de seu cadastro de pagamento. Verifique que a conta usa Workers Free e suas cotas. Basic Auth e validações usam CPU; o limite gratuito precisa ser medido na homologação real, especialmente na exportação. Nada contrata ou faz upgrade de plano automaticamente por este código.

## Ativação posterior — exige autorização separada

Após conferir conta, nome do Worker, isolamento e testes:

1. O responsável cadastra `HOMOLOG_BASIC_AUTH` em **Settings → Variables & Secrets** como **Secret**, não como variável de build. Um Secret definido somente no build não atende ao runtime. Não use `--secrets-file` nem envie arquivos privados.
2. Define `APP_ORIGIN` com a origem HTTPS final exata, sem barra final. `APP_LOCAL_ORIGINS` deve estar ausente, inclusive sem `[]` ou string vazia. URL/chave publishable Supabase, quando autorizadas, ficam somente no runtime do Worker. Não use service role e não modifique credenciais existentes. Sem configuração Supabase, a barreira pode liberar a interface, mas o aplicativo continuará informando a configuração pendente.
3. Confirma o projeto Supabase de homologação e o estado das quatro migrações existentes, por inspeção autorizada independente. Nada as aplica automaticamente. Banco novo não contém os dados ou sites do projeto anterior.
4. Uma alteração revisada desta configuração poderá habilitar somente o hostname HTTPS pretendido (`workers_dev: true`, se escolhida essa opção sem domínio próprio), mantendo `preview_urls: false` e a barreira obrigatória. Com o Secret ausente, mesmo um hostname habilitado responderá 503, sem expor a aplicação.
5. Só depois de aprovação explícita, troca o dry-run pelo deploy com a configuração **de homologação** e publica o commit revisado. Conectar Builds significa que pushes futuros à branch selecionada podem publicar; use branch de release revisada quando iniciar essa automação.
6. Testa janela anônima sem Basic (401), segredo ausente (503 em teste isolado), credencial errada (401), Basic correto seguido de login Supabase, rejeição de Origin externo, usuário inativo e isolamento. Verifica também o iframe sandbox e a exportação quando houver versão legítima revisada e sua ativação for autorizada.

Não habilite exportação apenas para preencher a ausência de sites: sem IA e banco sem versões, o estado vazio é esperado. O provedor simulado continua restrito aos testes. Recuperação por e-mail depende das URLs/template e do serviço de e-mail do ambiente, a serem revisados em etapa própria, sem alterar produção.

## Testes e limites da verificação

```sh
npm run format:check
npm run check
npm run test:e2e -- tests/e2e/homolog-access.spec.ts
```

Os testes unitários exercitam a barreira e a entrada real, bloqueio antes de assets/rede, todos os métodos/caminhos relevantes, HTTPS, segredo ausente/inválido, erros criptográficos, remoção de credenciais, ausência de logs, cache, login simulado, cookies, Origin/CSRF e membros inativos.

Os testes de navegador iniciam um servidor TLS descartável em loopback, usam o bundle real e a barreira real, e conferem HTTP Auth nativo, assets, a exigência de sessão Supabase e o renderizador real em iframe isolado. O certificado autoassinado é criado em diretório temporário e removido; somente esse contexto de testes ignora erros de certificado. Isso não é uma opção do aplicativo nem uma recomendação para o ambiente hospedado. O endpoint de frame sintético existe apenas no servidor de testes.

Não há Supabase remoto, credencial real, chamada de IA ou publicação nos testes. A CI existente continua usando bancos em memória/descartáveis; os filtros de branches foram ampliados para revisar esta branch e sua base. Homologação com Auth hospedado e medição no Workers Free ainda precisam de autorização e execução no ambiente alvo.

Referências: [Workers Builds e branches](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/), [configurações de build](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/) e [roteamento workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/).
