# Contrato de sites — Etapa 1

Esta etapa adiciona somente schemas de documentos e uma consulta de elegibilidade no backend. Não adiciona interface, rota HTTP, geração, provedor de IA, persistência de sites, filas, prévia ou exportação. Nenhuma tabela ou migração foi criada ou alterada.

## Documento estruturado

`shared/studio-sites.ts` exporta `siteDocumentSchema`, os schemas de identidade/página/seção/botão/opções visuais, os tipos correspondentes e `parseSiteDocumentText`. O contrato é versionado por `schema_version: 1`.

| Estrutura  | Conteúdo permitido                                                                                             |
| ---------- | -------------------------------------------------------------------------------------------------------------- |
| Identidade | Nome da empresa, tagline opcional, quatro cores `#RRGGBB`, fontes de sistema, estilo e arredondamento por enum |
| Página     | ID, caminho interno, título, descrição e seções                                                                |
| `hero`     | Título, texto, chamada opcional e até dois botões                                                              |
| `text`     | Título e parágrafos                                                                                            |
| `cards`    | Título, introdução opcional, itens e quantidade de colunas permitida                                           |
| `cta`      | Título, texto opcional e um ou dois botões                                                                     |
| `contact`  | Título, texto opcional e até quatro botões                                                                     |
| Visual     | Alinhamento, largura, espaçamento e superfície por enum                                                        |

Todos os objetos do documento são estritos: campos desconhecidos são rejeitados, inclusive HTML, CSS arbitrário, scripts, atributos de eventos, componentes livres e dados de aprovação. Textos são simples, com limites por campo e sem marcação HTML/caracteres de controle indevidos. Essa validação não substitui o escape de texto/atributos de um renderizador futuro. Entidades textuais não devem ser interpretadas como HTML ou instruções executáveis.

Os limites iniciais são:

- 128 KiB em UTF-8, cinco páginas, 12 seções por página e 40 no site inteiro.
- Oito parágrafos por seção de texto, cada um com até 2.000 caracteres.
- 12 cards, com títulos de até 100 e descrições de até 1.000 caracteres.
- Títulos de seção até 160 caracteres; rótulos de botão até 80.
- IDs até 64 caracteres, caminhos até 160 e URLs até 2.048.
- Página inicial `/` obrigatória. IDs de páginas e caminhos únicos; IDs de seção únicos dentro da página.
- Cada página começa com sua única seção `hero`. Links internos precisam apontar para uma página/seção existente.

`parseSiteDocumentText` limita bytes **antes** de interpretar JSON; o schema também limita o objeto validado. Uma API futura deverá limitar o corpo real da requisição antes de desserializá-lo, como a infraestrutura atual já faz para seus endpoints.

## Links

São aceitos caminhos internos canônicos, âncoras existentes, HTTPS com domínio em formato público, `mailto` com um destinatário simples e `tel` com 8 a 15 dígitos e `+` opcional. Não há envio ou acesso automático aos links.

São rejeitados protocolos executáveis, HTTP, URLs sem protocolo, credenciais embutidas, portas alternativas, hosts locais/IPs literais, caminhos com navegação relativa, controles, aspas/markup em bruto e parâmetros extras de e-mail. Caminhos internos não aceitam query string, segmentos `..`, percent-encoding ou barras finais, exceto `/`.

Isso é validação de formato, não autorização de acesso à rede. Um domínio com sintaxe válida pode resolver para endereço privado ou redirecionar para outro destino. Qualquer integração futura que baixe conteúdo precisa de controles próprios de DNS, IP, redirecionamentos, tamanho e tempo. O contrato também não comprova propriedade, licença ou veracidade do conteúdo de uma URL.

## Elegibilidade no backend

`server/studio-site-eligibility.ts` exporta `getSiteGenerationEligibility(context, input)`, sem registrar uma rota. O contexto deve vir do middleware de autenticação existente: usuário verificado e cliente Supabase com o JWT desse usuário. Não deve ser montado com dados do navegador, nem usar service role.

A entrada aceita exclusivamente `project_id`, `brief_version_id` e `brief_hash`. São expectativas para identificar mudanças, não provas de aprovação. Propriedades como `approved`, `approval`, `fields`, `user_id` ou `mode` são rejeitadas.

O helper faz somente leitura, utilizando o RPC **já existente** `studio_project_detail` com `p_version_id: null`. Esse RPC verifica associação ativa, passa pelo RLS e obtém a versão atual do projeto. Não há dados de aprovação fornecidos pelo frontend nessa decisão.

A consulta verifica:

1. Contexto autenticado e entrada válida.
2. Projeto e vínculo da versão com esse projeto.
3. Versão atual, ID esperado e hash esperado.
4. Aprovação persistida correspondente ao projeto, versão, hash e responsável autenticado. A correspondência do ator segue o modelo atual por usuário, sem workspace compartilhado.
5. Formato completo dos campos e exclusividade de conteúdo fictício para demonstrações.
6. Conteúdo público essencial autorizado.

Nesta primeira fase, os cinco campos obrigatórios do briefing também precisam estar confirmados, com origem e uso público autorizado: **nome da empresa, segmento, cidade, serviços e público-alvo**. A regra acompanha `briefFieldDefinitions`. A função não altera permissões para tornar o briefing elegível.

Uma aprovação de briefing com campos privados continua válida para planejamento, mas pode não ser suficiente para preparar um site público. Nesse caso, o retorno identifica somente as chaves faltantes, sem incluir valores privados.

Quando elegível, o contexto contém IDs de projeto/versão/aprovação, hash, modo e `public_information`. Inclui apenas valores públicos verificados, ou fictícios em demonstrações. Origens, snapshot, título interno, notas do diretor e campos privados/pendentes não são enviados nesse contexto. Os valores preservam o texto original persistido; a validação não troca o conteúdo associado ao hash por uma cópia com normalizações.

O hash é lido do banco e comparado ao da aprovação e ao esperado pelo solicitante. A integridade entre campos e hash continua garantida pela restrição e imutabilidade da migração atual do Studio; o helper não implementa uma segunda serialização do JSONB para recalcular esse hash em JavaScript.

Os retornos são discriminados por `eligible`. Falhas usam códigos como `authentication_required`, `brief_changed`, `brief_not_approved`, `insufficient_public_information` ou `read_unavailable`. Erros de banco são sanitizados; senhas, tokens, textos e erros brutos não são registrados em logs.

Elegibilidade é uma leitura pontual, não uma autorização durável de geração. Uma integração futura deverá revalidar o estado ao admitir o trabalho/reservar consumo. O frontend pode informar versão/hash esperados, mas nunca substituir os registros persistidos por um objeto de aprovação próprio.

## Testes e limites desta entrega

```bash
npm run format:check
npm run check
npm run test:e2e
```

`tests/studio-sites.test.ts` cobre estrutura, limites, referências internas, tipos de componentes, opções visuais e links. `tests/studio-site-eligibility.test.ts` cobre consulta à fonte persistida, rejeição de aprovações do cliente, versões/hashes divergentes, privacidade, conteúdo insuficiente e falhas de leitura. O RPC é simulado nesses testes; os testes já existentes do Studio exercitam suas políticas em PostgreSQL temporário em memória. Não são usadas credenciais nem banco remoto.

Fixtures sintéticas são exclusivas dos testes. Nenhuma empresa é inserida na aplicação.

O schema não comprova fatos comerciais, qualidade estética, contraste, direitos de imagem ou correspondência factual de um documento com o briefing. Uma validação futura precisará ligar a saída ao contexto autorizado e exigir revisão humana. Não há renderizador, executor, assets, provedor, geração, rota, persistência de sites, prévia, ZIP ou publicação nesta etapa. A Etapa 2 permanece pendente de autorização.
