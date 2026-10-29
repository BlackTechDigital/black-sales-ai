# Central de descoberta — etapa inicial

A página `/discover` filtra resultados já importados por cidade, UF e segmento. Passos, MG é a seleção inicial, sem registros pré-carregados. Não existe busca externa ativa nesta entrega. Não foram copiados códigos do Buscando 1 Milhão: a investigação anterior encontrou instruções de produto, sem implementação verificável dessas funções, e o fluxo foi implementado nesta arquitetura.

## Testar localmente

1. Use Node.js 24 e a branch `codex/company-discovery`. Ela contém as funcionalidades das PRs #1 e #2; o PR desta entrega depende da #2 enquanto as anteriores não forem integradas.
2. Preserve sua configuração existente. Caso ainda não exista `.dev.vars`, use `.dev.vars.example` como referência, seguindo [SUPABASE.md](SUPABASE.md). Configure somente no servidor `APP_ORIGIN=http://localhost:5173`, `SUPABASE_URL` e `SUPABASE_PUBLISHABLE_KEY`. Não use variáveis `VITE_*` para essas credenciais.
3. O banco de homologação precisa da migração de fundação `202610290001_foundation.sql` e, depois, de `202610290002_discovery.sql`. O responsável deve revisar e aplicar a segunda **somente após autorização para esse banco**, sem reaplicar a primeira em um banco que já a possui. Esta entrega não executou SQL remoto. O painel passa a consultar a relação de origem nas oportunidades e requer a segunda migração integral.
4. Execute:

   ```bash
   npm ci
   npm run dev
   ```

5. Acesse **http://localhost:5173**, entre com uma conta de homologação liberada em `app_members` e abra **Descobrir empresas**, também disponível em **http://localhost:5173/discover**.
6. Confira os filtros iniciais Passos/MG e o aviso de ausência de fontes. Abra **Importar resultados**. Preencha uma empresa com informações que você tenha coletado legitimamente; informe a fonte, opcionalmente sua URL pública, e a data/hora real da coleta. Não há empresa nem data de coleta preenchidas automaticamente. A data/hora do formulário usa o fuso do navegador e é enviada em UTC.
7. Clique em **Revisar importação**, confira os totais e confirme. O resultado salvo deve aparecer nos filtros correspondentes, inclusive após recarregar. Resultados fora dos filtros atuais continuam salvos; ajuste cidade, UF e segmento para vê-los.
8. Clique em **Adicionar ao pipeline** e revise a confirmação. Só **Confirmar adição** cria a oportunidade, na etapa **Novo**, com presença digital **Ainda não analisado**. Fonte e coleta ficam acessíveis no resultado e no pipeline. Site informado é apenas um link, sem inferir diagnóstico.
9. Repita a importação e tente adicionar novamente: não deve haver outra oportunidade. Confira também um cadastro anterior com o mesmo nome/cidade, inclusive na lixeira; o sistema mostra uma possível duplicata e preserva o original.
10. Confirme que login, recuperação de senha, cadastro manual, edição, histórico, rascunhos, importação v1, lixeira e restauração continuam funcionando. Com outro usuário ativo, os resultados e oportunidades do primeiro não devem aparecer. Um usuário revogado perde acesso.

Sem Supabase configurado, o login mostra a conexão pendente. Não há modo demonstrativo com empresas fictícias. A execução local não aplica migrações nem publica o aplicativo.

## Formato da importação JSON

Na opção **Arquivo JSON**, envie um array de 1 a 500 objetos, até 2 MB. A fonte e a data são preenchidas separadamente e se aplicam a todo o arquivo. Separe arquivos quando as origens ou datas diferirem.

| Campo     | Regra                                                          |
| --------- | -------------------------------------------------------------- |
| `company` | Nome informado da empresa; obrigatório, até 100 caracteres     |
| `city`    | Cidade sem UF; obrigatória, até 70 caracteres                  |
| `state`   | Sigla brasileira em maiúsculas, como `MG`; obrigatória         |
| `sector`  | Segmento informado; obrigatório, até 80 caracteres             |
| `contact` | Contato público, opcional, até 160 caracteres                  |
| `website` | URL http/https sem credenciais, opcional, até 1.000 caracteres |

O botão de download fornece apenas a estrutura vazia `[]`; ela precisa ser preenchida antes da importação. Campos desconhecidos, classificações de análise e identificadores de proprietário são rejeitados. O arquivo de backup v1 continua sendo importado pelo painel de oportunidades; não é o formato da descoberta.

Fonte e coleta são obrigatórias. Datas inválidas ou futuras são rejeitadas, com tolerância de cinco minutos para diferença de relógio. URLs são metadados e links: a API não visita o site nem a URL da fonte.

## Persistência e deduplicação

- `discovery_results`: dados informados, UF, site, fonte, coleta e data de entrada. Uma restrição única usa empresa + cidade + UF normalizadas para maiúsculas/minúsculas, espaços e os acentos portugueses tratados pela função SQL. Repetições no arquivo ou na base são ignoradas, preservando a primeira fonte e os valores originais.
- `discovery_origins`: vínculo permanente entre um resultado e a oportunidade criada. Permite manter a procedência sem alterar o formato ou as políticas dos leads existentes. O campo anterior `leads.source` continua `manual` para essa entrada manual; a relação de origem identifica a descoberta na API/interface.
- A prévia não grava dados. A confirmação revalida e insere os resultados em transação; qualquer linha inválida desfaz a importação inteira.
- Antes da adição, a listagem procura possíveis duplicatas no pipeline. A confirmação verifica novamente no banco, sob bloqueio transacional por usuário, e cria oportunidade, vínculo e histórico atomicamente. Repetir a adição retorna o registro existente.
- O pipeline é comparado por nome e cidade normalizados, independentemente de contato ou segmento. Reconhece cidades antigas como `Passos`, `Passos, MG`, `Passos - MG`, `Passos/MG` e `Passos (MG)`. Quando o cadastro antigo informa UF, ela deve coincidir; sem UF, a correspondência é conservadora. Registros arquivados também contam. O vínculo de origem impede uma nova adição mesmo após renomear ou arquivar uma oportunidade descoberta.

Sem CNPJ e endereço estruturado, isso não comprova identidade jurídica. Empresas homônimas/filiais podem ser bloqueadas como possíveis duplicatas; nomes ou cidades diferentes podem escapar da comparação. Não há fusão, sobrescrita ou liberação forçada. Revise o cadastro original. O cadastro manual e o importador v1 mantêm suas regras anteriores de identidade; este módulo não altera essas regras globalmente.

Os resultados e vínculos são imutáveis pela API e por usuários autenticados no banco: recebem apenas permissões de leitura/inserção, com RLS por proprietário e membro ativo. A API não usa service role. Exclusão, correção e múltiplas fontes por empresa ficam para uma etapa posterior. Uma reimportação não atualiza a fonte anterior.

A exportação v1 não contém resultados de descoberta nem suas origens. Backup completo precisa incluir as duas novas tabelas, além das tabelas existentes e dos usuários do Auth.

## Integração futura com fontes autorizadas

`server/discovery-sources.ts` define o contrato de um adaptador, com filtros, cancelamento, registros e procedência. O registro de provedores está vazio; `/api/discovery/sources` informa isso explicitamente. Ainda não há execução de pesquisa externa nem endpoint de scraping. Chaves futuras pertencem ao runtime do servidor, sem inclusão no bundle.

Antes de ativar um adaptador, revise autorização/termos, quotas, licença, retenção e finalidade de uso; implemente transporte, limites, paginação e testes próprios. Valide a resposta no mesmo contrato e registre a procedência real. A ativação de APIs exige implementação adicional, não apenas preencher uma chave. Esta etapa não configura serviços, custos ou provedores pagos.

## Verificações e limites da homologação

```bash
npm run format:check
npm run check
npx playwright install chromium
npm run test:e2e
```

SQL e RLS são exercitados em PostgreSQL WASM/PGlite temporário, em memória, incluindo preservação de um registro existente antes da segunda migração. Testes de API simulam o cliente Supabase, e testes de navegador simulam HTTP em desktop/celular. Fixtures sintéticas existem exclusivamente nos testes e não são carregadas na aplicação.

Transporte PostgREST, autenticação real e configuração de um Supabase hospedado ainda requerem homologação autorizada. Não foram executados nesta entrega. Não há migração remota, publicação, scraping, análise automática ou envio de mensagens.
