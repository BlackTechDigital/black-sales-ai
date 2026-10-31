# Login local em dois computadores, mantendo Origin e CSRF

O navegador em `http://192.168.18.7:5173` envia essa origem no login. Ela é diferente de `http://localhost:5173`. Antes desta correção, o backend comparava o header somente com `APP_ORIGIN`, por isso o acesso pelo IP retornava 403 antes de consultar o Supabase. Apenas trocar `APP_ORIGIN` pelo IP também não resolve esta implementação: HTTP no endereço principal continua restrito a loopback.

A configuração adicional é exclusiva do backend local. Não habilita CORS, não aceita `*`, não altera credenciais e não libera automaticamente outros endereços da sub-rede. Cada origem inclui protocolo, host e porta exatos. Não vem de `Host`, `X-Forwarded-*`, corpo da requisição ou variáveis `VITE_*`.

## Configurar no PC 1

Primeiro atualize os arquivos desta correção no PC 1 e encerre somente as instâncias anteriores de Vite/Wrangler desse projeto. Preserve seu arquivo `.dev.vars` e todas as credenciais Supabase já configuradas.

Edite ou acrescente **somente** estas duas configurações no `.dev.vars` local, sem duplicar as linhas:

```dotenv
APP_ORIGIN=http://localhost:5173
APP_LOCAL_ORIGINS='["http://192.168.18.7:5173"]'
```

O arquivo é ignorado pelo Git; não o envie por chat, commit ou screenshot. Não altere `SUPABASE_URL` nem `SUPABASE_PUBLISHABLE_KEY`. Nenhuma variável de origem precisa estar no frontend. A lista deve ser JSON, sem barra final, caminhos, query, fragmento ou wildcard. O limite é oito entradas.

`APP_LOCAL_ORIGINS` só é aceita quando `APP_ORIGIN` é HTTP em `localhost` ou `127.0.0.1`. As entradas adicionais devem ser HTTP em loopback ou IPv4 privado RFC1918. Essa classificação valida a configuração, mas **não autoriza a sub-rede inteira**: a comparação da requisição continua exata. Configuração inválida falha fechada. Não configure essa variável em produção HTTPS.

Em um terminal no diretório do projeto:

```bash
npm ci
npm run dev
```

Isso mantém o frontend em `127.0.0.1:5173` e a API em `127.0.0.1:8787`. Em **outro terminal**, na mesma pasta:

```bash
npm exec -- vite --host 192.168.18.7 --port 5173 --strictPort
```

São dois listeners Vite, em interfaces diferentes, para preservar localhost sem escutar em todas as interfaces. Ambos carregam a mesma configuração e encaminham `/api` para a API loopback. Não use `--host 0.0.0.0` no Wrangler e não exponha a porta 8787 na rede. Não precisa executar migrações ou alterar serviços Supabase para corrigir o login por senha.

Confirme que `192.168.18.7` ainda é o endereço do PC 1, por exemplo com `ipconfig` no Windows. Se mudar, a origem e o comando de bind precisam ser atualizados explicitamente. `strictPort` impede troca silenciosa para outra porta.

## Rede e firewall

Use uma rede privada confiável. Se o firewall bloquear o PC 2, autorize somente TCP 5173, na interface/endereço do PC 1, perfil privado e preferencialmente no IP exato do PC 2. Não abra regra para todas as redes, não abra 8787, não use encaminhamento de portas no roteador, túnel público ou UPnP. Nenhuma regra de firewall é criada por esta correção.

Se a interface em `192.168.18.7:5173` já abre no PC 2, o erro de Origin não exige abrir novas portas; preserve as regras existentes e corrija a configuração do backend.

HTTP na LAN não cifra senhas e cookies no trajeto entre o navegador e Vite. A validação de Origin/CSRF não substitui TLS. Para uso com dados sensíveis ou além de homologação em rede confiável, prepare HTTPS local com certificado confiável em ambos os computadores em uma tarefa separada; não desabilite a validação de certificados.

## Verificar no PC 1 e PC 2

1. No PC 1, abra `http://localhost:5173`, entre e recarregue. A sessão deve continuar válida.
2. Ainda no PC 1, abra `http://192.168.18.7:5173` e entre novamente. Endereços diferentes possuem cookies diferentes.
3. No PC 2, abra **o IP do PC 1**: `http://192.168.18.7:5173`. `localhost` no PC 2 aponta para o próprio PC 2. Entre e recarregue.
4. Em Network, confira que o login usa `/api/login` pela porta 5173 e que `Origin` corresponde à barra de endereço. Um login válido retorna 200; usuários não liberados continuam bloqueados.
5. Em Application/Cookies, confira apenas os atributos, sem copiar valores: HttpOnly, SameSite=Strict, Path=/ e sem Domain explícito. HTTP local não recebe Secure; HTTPS continua usando Secure e nomes `__Host-`. Cookies não são compartilhados entre computadores nem entre localhost e IP.
6. Verifique origens não autorizadas pelos testes, sem enviar credenciais reais para outros hosts. Porta diferente, outro IP, Origin ausente/`null` e `Sec-Fetch-Site: cross-site` devem continuar bloqueados.

O proxy preserva o Origin do navegador. Não o reescreva para localhost para evitar o erro: isso esconderia a origem real da requisição. Não adicione `Access-Control-Allow-Origin: *`, `SameSite=None`, cookies de domínio amplo ou bypass de CSRF.

Se o IP não abre, investigue bind, endereço e firewall. Se localhost funciona e o IP retorna o erro de origem, confira a lista e reinicie **Wrangler** depois de alterar `.dev.vars`. Um 503 de configuração pode indicar JSON/origem inválidos; não enfraqueça as validações para contorná-lo.

## Recuperação e limites do navegador

A recuperação agora usa a origem explicitamente autorizada que iniciou a solicitação, preservando o callback do mesmo navegador. Para testar e-mail na LAN, a URL exata `http://192.168.18.7:5173/reset-password` também precisará estar autorizada no Supabase de **homologação**. Não altere configurações de produção para esse teste. Login comum com senha não depende desse redirecionamento.

Em HTTP no IP privado, o navegador não considera a página um contexto seguro. O Studio agora gera UUIDs com `crypto.getRandomValues` e pode abrir/criar/editar projetos mesmo sem `crypto.randomUUID`. A verificação de integridade do ZIP continua usando `crypto.subtle`, que pode faltar em HTTP: nesse caso, a prévia/revisão permanecem disponíveis, mas o download é bloqueado com orientação para HTTPS ou localhost. Não há fallback criptográfico inseguro nem flag para desabilitar a proteção do navegador. Veja [BROWSER_COMPATIBILITY.md](BROWSER_COMPATIBILITY.md) para a correção da tela preta, barreiras de erro e testes.

## Testes reproduzíveis

```bash
npm run typecheck
npm test -- tests/origins.test.ts tests/lan-api.test.ts tests/api.test.ts tests/recovery.test.ts tests/recovery-transport.test.ts
npm run build
npm run test:e2e -- tests/e2e/lan-origins.spec.ts --project=desktop
```

Se necessário neste workspace, configure `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium` somente no comando de teste. Os testes usam credenciais fictícias e transporte Supabase simulado. O teste de navegador emula as URLs dos dois PCs, encaminha as chamadas pelo proxy Vite real e verifica o backend real, Origin preservado, cookies host-only, sessão após reload e rejeição de um IP não listado. Não comprova o firewall, a conectividade física ou o Supabase real dos seus computadores; esses itens precisam dos passos manuais acima.
