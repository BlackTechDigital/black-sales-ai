# Configuração do Supabase — execução manual após autorização

Esta implementação não criou projeto, configurou cobrança, aplicou SQL remoto nem acessou dados reais. Os passos abaixo são instruções para o responsável pelo ambiente, não ações já realizadas.

## 1. Escolher um ambiente de homologação

Use projeto separado, no plano gratuito, após aprovação do responsável. Se o projeto existente já contém dados, faça backup e revise possíveis conflitos de tabelas antes de qualquer migração. Não conecte inicialmente a produção.

A migração cria `public.app_members`, `public.leads`, `public.lead_events` e funções associadas. Se houver objetos com esses nomes, a transação falha: ela não remove ou substitui tabelas existentes. A integração usa chave publishable (ou anon legada) somente na API; não precisa de service role, chave secret nem senha do PostgreSQL em runtime.

## 2. Revisar e aplicar a migração, somente com autorização

Revise `supabase/migrations/202610290001_foundation.sql`. Após autorização explícita para esse banco, aplique o arquivo integral uma única vez pelo SQL Editor ou pelo fluxo de migração da equipe. A transação não contém comandos para apagar dados existentes.

Para esta versão com descoberta, revise também `supabase/migrations/202610290002_discovery.sql` e aplique, após autorização, **depois** da fundação. Ela adiciona `discovery_results`, `discovery_origins`, RLS e funções; preserva leads e histórico existentes. Não reaplique migrações já aplicadas. O painel consulta as origens pelo PostgREST e requer essa migração integral. Veja [DISCOVERY.md](DISCOVERY.md) para a homologação local do módulo.

Não execute comandos de reset nem aplique em um banco real apenas para rodar os testes deste repositório. `npm test` já valida SQL/RLS em banco temporário na memória.

O Creative Studio usa a migração aditiva `supabase/migrations/202610290003_studio.sql`, aplicada após as duas anteriores e somente com autorização. Ela cria `studio_projects`, `studio_brief_versions`, `studio_brief_approvals` e RPCs com verificações explícitas de proprietário/membro ativo. Não concede escrita direta nas novas tabelas. O módulo não cria buckets nem configura IA. Detalhes e roteiro de homologação em [STUDIO.md](STUDIO.md). As rotas anteriores não consultam tabelas do Studio.

## 3. Preparar autenticação restrita

No Supabase Auth:

1. Desative novos cadastros públicos e login anônimo.
2. Habilite e-mail/senha e use as políticas de senha e limites de tentativas do projeto.
3. Crie um usuário de homologação pelo dashboard, verificando o e-mail conforme a política da equipe.
4. O login aceita e-mail/senha estabelecidos. A recuperação foi implementada em `/reset-password`; siga [PASSWORD_RECOVERY.md](PASSWORD_RECOVERY.md) para autorizar redirecionamento, configurar o template e testar. Convites e confirmação de cadastro continuam fora deste fluxo.
5. Defina a URL local como `http://localhost:5173`. Antes de qualquer hospedagem futura, revise URLs permitidas, domínio HTTPS e política de sessão.

Uma conta válida ainda não tem acesso até entrar em `app_members`. Após autorização, libere o UUID correto do usuário, nunca um UUID inventado:

```sql
-- Substitua USER_UUID pelo UUID real em Authentication > Users.
insert into public.app_members (user_id, active)
values ('USER_UUID'::uuid, true);
```

Para revogar acesso, o administrador pode alterar `active` para `false`. A API verifica a associação em cada operação e o RLS bloqueia acesso aos registros. Usuários não podem se cadastrar na tabela nem reativar seu vínculo.

Os leads são isolados por usuário. Compartilhamento entre colaboradores precisa de uma etapa posterior com modelo de organização e permissões próprias.

## 4. Configurar somente o servidor local

```bash
cp .dev.vars.example .dev.vars
```

Edite o arquivo ignorado pelo Git:

```dotenv
APP_ORIGIN=http://localhost:5173
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_OR_ANON_KEY
```

Esses valores ficam no runtime do Worker. Não crie variáveis `VITE_SUPABASE_*`, não cole chaves em React e não adicione service role ao projeto. Mesmo a chave publishable fica fora do frontend nesta implementação.

`APP_ORIGIN` deve corresponder exatamente ao endereço usado no navegador, sem barra final. `localhost` e `127.0.0.1` são origens diferentes. Reinicie `npm run dev` após configurar.

Para prévia do build em `http://localhost:8787`, ajuste `APP_ORIGIN` para esse endereço e execute:

```bash
npm run build
npm run preview:local
```

Isso roda localmente, sem publicar.

## 5. Homologar o fluxo real

Com autorização e credenciais do ambiente de homologação, verifique login, logout, renovação de sessão, acesso negado de usuário inativo e isolamento entre dois usuários. Cadastre um registro de teste claramente identificado, edite, mova para a lixeira, restaure e confira histórico. Importe um arquivo de teste duas vezes, validando contagens e ausência de sobrescrita.

Esses passos contra Supabase hospedado **não foram executados nesta entrega**. PGlite valida o SQL, mas não substitui a configuração real do Auth e do PostgREST. Caso a API informe indisponibilidade, confira configuração, liberação do usuário e aplicação integral da migração; não desative o RLS para contornar o problema.

## Backup e recuperação

Antes da importação, preserve o JSON v1 original. O aplicativo só adiciona dados novos e conserva a origem no banco. Exclusões são lógicas; use **Lixeira > Restaurar** para recuperá-las.

A exportação v1 contém apenas registros ativos, sem eventos, lixeira ou procedência da descoberta. Para uma recuperação completa, o administrador deve manter backup do banco, incluindo `app_members`, `leads`, `lead_events`, `discovery_results`, `discovery_origins` e o mapeamento com os usuários do Auth. Uma restauração em outro projeto pode exigir reconciliação dos UUIDs; não force alterações de proprietário pela API.

Defina periodicidade, armazenamento protegido e teste de restauração em homologação antes de adotar o sistema em produção. O plano gratuito não deve ser tratado como garantia de disponibilidade ou backup gerenciado. Nenhum agendamento pago ou backup remoto foi configurado por esta entrega.

Para incluir o Creative Studio no backup completo, preserve também `studio_projects`, `studio_brief_versions` e `studio_brief_approvals`, incluindo os vínculos com usuários/oportunidades. A exportação v1 não contém projetos ou briefings.
