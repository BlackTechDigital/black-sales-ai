# Recuperação de senha — teste local

Esta alteração depende da fundação do PR #1. O PR de recuperação usa `codex/foundation-v2` como base enquanto a fundação não estiver em `main`. Nenhuma publicação, migração ou alteração de configuração remota foi executada por esta implementação.

## Configurar o ambiente existente

Use um projeto Supabase de homologação já autorizado e uma conta de teste com e-mail acessível. Não é necessário criar tabelas, aplicar migrações ou usar service role para redefinir a senha. O login no painel continua exigindo o vínculo ativo em `app_members` da fundação.

Copie `.dev.vars.example` para `.dev.vars`, somente se o arquivo local ainda não existir. Configure **no servidor**, preservando seus valores existentes:

```dotenv
APP_ORIGIN=http://localhost:5173
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_OR_ANON_KEY
```

Não crie variáveis `VITE_*` para essas credenciais. Não coloque tokens ou senhas em comandos de terminal, capturas, issues, logs ou arquivos versionados.

No Supabase Dashboard, em **Authentication > URL Configuration**, o responsável deve autorizar:

- Site URL de homologação: `http://localhost:5173`.
- Redirect URL: `http://localhost:5173/reset-password`.
- Se um cliente externo usar `sb_flow_id`, também pode precisar de `http://localhost:5173/reset-password?sb_flow_id=*`. O cliente deste aplicativo usa o fluxo PKCE padrão do SDK, sem habilitar recursos experimentais.

Não substitua o Site URL de um projeto de produção apenas para testar localmente. Use homologação ou peça ao responsável uma configuração adequada. Use sempre **localhost**, sem alternar para `127.0.0.1`: cookies e autorização de origem são diferentes.

## E-mail: opção recomendada

O template padrão com `{{ .ConfirmationURL }}` é compatível:

- Solicitações iniciadas em **Esqueci minha senha** usam PKCE. Abra o e-mail no mesmo navegador e perfil que iniciou a solicitação; o verificador fica em cookie HttpOnly.
- Links legados que retornam `access_token`, `refresh_token` e `type=recovery` no fragmento também são aceitos, inclusive na raiz da aplicação. Os tokens precisam ser confirmados no Auth e conter a finalidade de recuperação.

Para abrir o link em outro dispositivo/navegador, o responsável pode configurar **Authentication > Email Templates > Reset password** com o modelo fornecido em `supabase/templates/recovery.html`. Seu destino é:

```html
<a
  href="{{ .SiteURL }}/reset-password#token_hash={{ .TokenHash }}&amp;type=recovery"
>
  Definir nova senha
</a>
```

O fragmento após `#` não é enviado na requisição HTTP da página. O aplicativo o remove da URL e envia o hash ao servidor em JSON, para `verifyOtp({ token_hash, type: 'recovery' })`. O template só foi preparado em arquivo; não foi aplicado no provedor. Links emitidos antes de alterar o destino/template precisam ser solicitados novamente para testar a nova configuração.

O transporte PKCE exige o cookie do navegador que iniciou a solicitação. Solicitar outro link nesse navegador substitui o verificador anterior: use o e-mail mais recente. Um código emitido por outro aplicativo sem o verificador correspondente é rejeitado; a aplicação não tenta contornar essa proteção.

## Executar em http://localhost:5173

```bash
npm ci
npm run dev
```

1. Abra `http://localhost:5173` e clique em **Esqueci minha senha**.
2. Informe o e-mail da conta de teste. A mensagem de confirmação não revela se a conta existe.
3. Abra o link do e-mail. Em PKCE, use o mesmo navegador/perfil. O endereço deve chegar a `/reset-password` e ser limpo de parâmetros sensíveis.
4. Aguarde a validação. A página mostra a conta confirmada e os campos **Nova senha** e **Confirmar nova senha**. Nenhuma sessão de painel é criada pela recuperação.
5. Defina uma senha nova, com 12 a 128 caracteres, que também cumpra as regras do seu projeto Supabase.
6. Clique em **Salvar nova senha**. Ao receber confirmação, volte ao login e entre com a nova senha. A senha antiga deve deixar de funcionar.
7. Confirme que os registros e demais recursos continuam disponíveis para o mesmo usuário autorizado.

Se o e-mail foi enviado pelo administrador, o destino ainda precisa apontar para esse ambiente local. Abrir `/reset-password` sem um link ou cookie de recuperação válido não permite alterar a senha. Uma sessão normal do painel também não autoriza essa operação.

## Casos negativos

- Link expirado, consumido ou com hash/código alterado: mensagem clara e opção **Solicitar novo link**.
- Link aberto em outro navegador quando usa PKCE: rejeição por ausência do verificador; solicite novamente nesse navegador ou utilize o template recomendado.
- Senhas diferentes: rejeição local e no servidor, sem atualização.
- Senha recusada pelo Supabase: a página informa o problema e permite tentar outra senha durante a janela válida.
- Indisponibilidade de rede/Auth: mensagem de falha temporária. A aplicação não mostra sucesso sem confirmação do provedor.
- Recarregar a página após validar: a recuperação pode continuar pelos cookies protegidos até a expiração. O token/hash não é resgatado novamente.

O aplicativo limita a autorização a até **15 minutos a partir da autenticação de recuperação**, também respeitando a expiração do JWT. O prazo do link de e-mail anterior à validação continua sendo controlado pelo Supabase. Ao salvar, o servidor renova e confere o usuário e a sessão correspondentes, atualiza a senha, limpa os cookies locais e solicita revogação global das sessões de refresh. JWTs já emitidos seguem a validade do provedor; não é prometida invalidação instantânea de todos os JWTs. Falha na revogação é informada separadamente de uma senha já salva.

## Testes automatizados e limites da verificação

```bash
npm run format:check
npm run check
npx playwright install chromium
npm run test:e2e
```

Os testes verificam parsing e limpeza dos links, rejeição de sessão comum/claims incorretas, confirmação de senha, expiração, erro de política, recusa de origem externa, ausência de credenciais em logs e preservação do fluxo comercial. Testes de transporte executam o SDK Supabase realmente instalado contra um servidor HTTP simulado, incluindo geração do desafio PKCE e conferência do verificador. Os testes de navegador também usam respostas HTTP simuladas e contas fictícias exclusivamente de teste.

Não foi enviado e-mail real nem alterada senha em Supabase hospedado nesta entrega. O teste manual descrito acima depende das credenciais, da configuração de redirecionamento/template e da entrega de e-mail do ambiente autorizado.

## Operação segura

O callback é processado antes da montagem do React e os parâmetros são removidos com `history.replaceState`. Senhas e provas de recuperação não são gravadas em localStorage/sessionStorage. O hash/verificador/JWT não aparece nas respostas JSON. Cookies de recuperação são separados do login, com HttpOnly, SameSite=Strict e Secure em HTTPS.

A aplicação não registra URLs, corpos de requisição, senhas, tokens ou erros brutos do provedor. O fetch do servidor tem timeout e transforma exceções de transporte em uma resposta genérica para evitar logging interno do SDK com detalhes sensíveis. Não habilite captura de corpos/cookies ou tracing com credenciais reais. Se houver proxy/analytics externo, mantenha redaction de query strings de callbacks PKCE; links com `#token_hash` evitam o segredo na URL HTTP inicial. A configuração fornecida do Worker mantém observabilidade externa desabilitada e usa `no-store` e `no-referrer` na recuperação.

A checagem de origem, os cookies protegidos, a verificação remota e a finalidade `recovery` nos claims assinados são obrigatórios. Não desabilite essas proteções para aceitar links incompletos. Custom access token hooks devem preservar os claims de recuperação necessários. O fluxo não usa acesso administrativo nem altera políticas RLS.

Referências oficiais: [Password-based Auth](https://supabase.com/docs/guides/auth/passwords), [PKCE](https://supabase.com/docs/guides/auth/sessions/pkce-flow), [templates de e-mail](https://supabase.com/docs/guides/auth/auth-email-templates) e [claims de autenticação](https://supabase.com/docs/guides/auth/auth-hooks/custom-access-token-hook).
