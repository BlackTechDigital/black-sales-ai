# Prévia segura de sites — Etapa 5

Branch: `codex/studio-site-preview`. Esta etapa permite consultar versões salvas e visualizar o documento estruturado dentro do Creative Studio. Não gera conteúdo novo, não chama IA, não aprova/publica sites e não altera tabelas, migrações ou os contratos das Etapas 1–4.

## Renderização controlada

`server/studio-preview-renderer.ts` valida o JSON com `shared/studio-sites.ts` e cria HTML a partir de funções próprias. O documento não fornece markup, CSS, scripts, nomes de tags, eventos ou recursos executáveis. São suportados somente identidade, páginas e os cinco componentes existentes: `hero`, `text`, `cards`, `cta` e `contact`.

- Identidade aplica as quatro cores hexadecimais, fontes de sistema, estilo e arredondamento permitidos. CSS é inteiramente escrito no renderizador; dados só escolhem valores enumerados ou cores estritas `#RRGGBB`.
- Seções aplicam alinhamento, largura, espaçamento e superfície por classes permitidas. Cards têm grids responsivos; textos preservam espaços/quebras de linha, são escapados e nunca interpretados como HTML. Entidades como `&lt;script&gt;` aparecem literalmente, sem decodificação como markup.
- Navegação entre páginas e âncoras usa fragmentos locais gerados a partir dos IDs validados, com prefixos que evitam colisões. CSS `:target`/`:has` alterna as páginas sem JavaScript. Não há navegação para URLs do aplicativo, mensagens `postMessage` ou leitura do DOM do iframe pelo painel.
- Botões HTTPS, `mailto` e `tel` aparecem como elementos inativos e identificados como desativados. Destinos externos não são incluídos sequer em atributos ou código-fonte da prévia. Não abrem abas, chamadas ou aplicativos externos.
- **O contrato v1 não contém imagens.** Campos de imagem continuam inválidos. Nenhuma imagem, fonte remota, asset, iframe interno ou URL é carregada; não há seleção automática de imagens nem pesquisa de licenças nesta etapa.

O limite de 128 KiB também é conferido no JSON original antes da renderização. O Zod pode normalizar strings durante validação; o renderizador utiliza os valores originais persistidos após validar, preservando o conteúdo associado ao hash do JSONB. Não altera nem regrava o documento para produzir a prévia.

## API de leitura e correspondência da versão

Base: `/api/studio/projects/:id/site-preview`.

| Endpoint autenticado                                | Resposta                                                                                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /versions?offset=0`                            | Até 20 metadados de versões por número decrescente, ponteiros da versão atual do site/briefing e `has_more`.                          |
| `GET /versions/:versionId?document_hash=HASH`       | Valida o documento no backend antes de devolver apenas metadados da seleção e os ponteiros atuais. Não retorna JSON do site nem HTML. |
| `GET /versions/:versionId/frame?document_hash=HASH` | Repete autenticação, consulta e validação da seleção e entrega somente HTML do renderizador confiável com sua política de segurança.  |

Os endpoints herdam Supabase Auth, associação ativa e RLS de `/api/studio/*`. Aplicam filtros explícitos de usuário/projeto e verificam vínculo da versão ao site. Não usam service role. Seleção inexistente/de outro usuário/projeto não revela conteúdo. Hash incorreto retorna `409 preview_changed`; documento inválido retorna `422 invalid_document`; ausência de persistência retorna `503 migration_missing` com mensagem fixa.

A restrição existente no PostgreSQL garante que `document_hash` corresponde ao JSONB imutável. O backend compara o hash esperado com esse registro, sem substituir a serialização PostgreSQL por `JSON.stringify` para calcular outro hash. Os headers `X-Studio-Site-Version` e `X-Studio-Document-Hash` identificam a versão servida no iframe.

O frontend valida os DTOs e confere ID/hash/número recebidos. Ao trocar de versão, remove imediatamente o iframe anterior, cancela a consulta antiga e ignora respostas atrasadas. O endereço do iframe é construído pelo aplicativo para um caminho fixo da API; não é uma URL fornecida pela IA. Os endpoints de metadados e HTML verificam a mesma seleção imutável, inclusive se a versão atual do projeto mudar entre as duas consultas.

O backend não consulta campos privados de briefing, fontes, contatos privados, snapshot, prompts ou credenciais para compor a prévia. Somente o documento salvo é renderizado. Uma prévia autenticada de versão histórica não reautoriza seu uso público: o painel informa quando o site ou seu briefing são antigos. Detectar fatos inventados ou informação sensível dentro de texto livre ainda exige revisão humana; o schema não é um verificador factual/de privacidade.

## Isolamento

O iframe usa URL HTTP autenticada, `sandbox=""`, `referrerPolicy="no-referrer"` e permissões de dispositivo bloqueadas. Sem `allow-scripts`, `allow-same-origin`, formulários, popups, downloads ou navegação superior. O navegador atribui uma origem opaca, impedindo acesso ao DOM, cookies e armazenamento do painel.

A resposta HTML aplica sua própria CSP por header: `default-src 'none'`, `script-src 'none'`, `style-src` somente com nonce aleatório por resposta, `style-src-attr 'none'`, `img-src 'none'`, `font-src 'none'`, `connect-src 'none'`, `media-src 'none'`, `object-src 'none'`, `frame-src 'none'`, `worker-src 'none'`, `base-uri 'none'`, `form-action 'none'`, `frame-ancestors 'self'` e `sandbox` sem permissões. A folha de estilos escrita pelo sistema é o único elemento com esse nonce.

Foi escolhida uma página HTTP com política própria, em vez de `srcdoc`/blob: esses documentos podem herdar a CSP do painel, cujo `style-src 'self'` bloqueia estilos inline mesmo quando uma política adicional tenta permiti-los. A solução mantém intacta a CSP principal e permite apenas o CSS nonced do renderizador no documento filho.

Somente a rota HTML da prévia remove o `X-Frame-Options: DENY` padrão, usando `frame-ancestors 'self'` para admitir o painel da mesma origem. Outros endpoints e páginas mantêm suas proteções. HTML de erro também recebe as mesmas restrições, sem detalhes de banco ou reflexão de parâmetros. As respostas têm `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `nosniff` e Permissions Policy restritiva. URL ou hash copiados não concedem acesso sem autenticação/autorização.

Falha de autenticação/banco após a validação inicial pode ser exibida como página segura de erro **dentro** do iframe. O painel não inspeciona o DOM/status HTTP do filho de origem opaca para contornar o isolamento; use atualizar/reabrir para uma nova consulta autenticada.

## Uso no Studio

Em `/studio`, abrir um projeto e clicar **Abrir prévia**. Escolher a versão salva; o painel identifica versão atual/antiga e briefing anterior. A prévia é somente leitura e permanece disponível com IA desativada, desde que existam versões e a persistência já esteja configurada.

Os controles usam viewports reais do iframe: **Desktop 1280 × 900**, **Tablet 768 × 1024** e **Celular 390 × 844**. A área é reduzida visualmente para caber no painel, mantendo a largura interna usada pelas media queries. O conteúdo tem rolagem própria; o painel não executa scripts dentro do iframe para medir sua altura. Fechar a prévia remove o iframe. Atualizar versões permite consultar gerações concluídas depois da abertura; metadados são fotografias da última consulta, sem polling de prévia ou troca automática da seleção para a versão mais recente.

Há estados de carregamento da lista/documento/iframe, lista vazia, falta de migração, documento inválido, versão divergente e falha de rede. Alterações locais do formulário não entram na prévia: ela mostra somente a versão de site salva selecionada. Não há botão de publicação ou exportação.

## Testar localmente sem consumo de API

```bash
npm ci
npm run format:check
npm run check
npm test -- tests/studio-preview-renderer.test.ts tests/studio-preview-api.test.ts
npm run test:e2e -- tests/e2e/studio-preview.spec.ts
npm audit --audit-level=high
```

Os testes de navegador desta etapa precisam do build em `dist` (**executar `npm run build` se não executou `npm run check`**). Eles servem o bundle compilado sob uma CSP como a de produção, simulam HTTP e usam documentos explicitamente sintéticos. Vite é apenas o servidor local; nenhuma chamada real é enviada a IA/Supabase. Para Chromium instalado, definir `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`; caso contrário usar o navegador instalado para Playwright.

`tests/fixtures/studio-preview.ts` contém o documento simulado de duas páginas, identidade e cinco componentes. Os testes do renderizador cobrem escape, limites, enums, rejeição de HTML/CSS/código/imagens/URLs perigosas, CSP e nonce. `tests/studio-preview-api.test.ts` usa SQL/RLS reais em PGlite **temporário em memória**, com autenticação/cliente PostgREST simulados e versões criadas pelas RPCs existentes, sem geração de IA. Testa isolamento entre usuários/projetos, membro inativo, hash, versão histórica, documento corrompido e dados privados. Não é homologação de Supabase hospedado.

Os testes de navegador cobrem os três tamanhos, navegação/âncoras por mouse/toque reais, seleção histórica, respostas atrasadas, ausência/erro, cookies da navegação inicial e origem opaca. Um caso adultera deliberadamente a resposta HTTP simulada com script/imagem para testar as barreiras do iframe/CSP, além da rejeição normal pelo backend. Comprova ausência de execução e de requisição externa. Playwright calcula incorretamente alguns bounds de links dentro de iframe cross-origin com CSS transform; o helper de teste mapeia coordenadas locais para a tela e envia input real, preservando o isolamento.

Para abrir o aplicativo normal, executar `npm run dev` e acessar **http://localhost:5173/studio**. Login exige um Supabase de desenvolvimento já configurado/autorizado; não é criado usuário ou banco por esta etapa. Sem versões salvas, abrir a prévia mostra o estado vazio. Para avaliar documentos simulados sem configurar serviços/credenciais, usar os testes acima; não existe rota pública de demonstração ou bypass de autenticação no aplicativo.

Compatibilidade visual foi testada em Chromium desktop/mobile; navegação sem scripts usa CSS moderno `:has`. Fontes de sistema, contraste e qualidade do conteúdo dependem dos valores do documento, sem garantia automática de qualidade comercial/acessibilidade. Não há imagens, execução de código, chat, ZIP, publicação, geração real de IA, migração remota ou contratação. A Etapa 6 permanece pendente de autorização.
