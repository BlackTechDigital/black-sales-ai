# Segurança e limites da fundação

## Fronteiras de confiança

O frontend chama apenas a API da mesma origem. O servidor usa o SDK oficial do Supabase com a chave publishable/anon e o JWT do usuário verificado; não usa service role. JWTs e refresh tokens não aparecem no JSON nem em localStorage: ficam em cookies HttpOnly, SameSite=Strict, Path=/ e Secure com prefixo `__Host-` quando em HTTPS.

A API valida `Origin` em todas as mutações, rejeita requisições cross-site e exige JSON. A implantação deve manter mesma origem e HTTPS. Requisições e erros de provedor não são registrados pela aplicação. Observabilidade externa do Worker fica desabilitada na configuração fornecida. Cabeçalhos CSP, anti-frame e anti-sniff são aplicados pelo Worker; o servidor Vite de desenvolvimento tem comportamento próprio. A lista de bloqueio também impede servir arquivos `.env`, `.dev.vars`, chaves e diretórios de backend, migrações e trabalho.

O Supabase Auth valida os tokens e controla o limite de tentativas. Não há um limitador de login em memória apresentado como proteção global. Antes de expor publicamente, revise limites de autenticação e proteção de tráfego do ambiente.

## Banco

RLS exige proprietário correspondente a `auth.uid()` e associação ativa. `app_members` não admite escrita de usuários. A política de leitura permite visualizar apenas o próprio vínculo. Não existe política de hard delete em leads, nem permissão para alterar, remover ou inserir eventos pela API.

O gatilho de auditoria executa com privilégios controlados para anexar snapshots; usa `search_path` vazio, objeto qualificado e ator obtido da sessão. Funções de mutação são security invoker e ficam sujeitas a RLS. Identidade, proprietário e origem de um lead são imutáveis. Cada edição gera uma versão e rejeita atualização com versão antiga.

A importação valida o lote inteiro e executa numa transação PostgreSQL. A prévia não grava. Restrições únicas protegem identidade e ID legado, inclusive sob concorrência. Um lock por usuário serializa importações. Conflitos não substituem dados e não geram fusões automáticas.

## Dados preservados

A aplicação não escreve na chave do navegador usada pela versão anterior. A recuperação baixa o conteúdo original, mesmo que ele precise de correção antes da importação. O HTML v1 fica no repositório para referência, fora dos assets distribuídos. `legacy_snapshot` conserva o objeto importado, com campos adicionais. As datas geradas representam entrada/mudança no novo sistema, sem inferir o passado.

Exclusão é arquivamento reversível. Uma política de retenção, descarte definitivo e atendimento a titulares precisa ser definida antes da operação real; esta etapa não oferece expurgo de dados nem promete retenção ilimitada como política de privacidade.

## Limites deliberados

- O template de abordagem não afirma ter analisado um site. Não há IA, coleta externa ou envio.
- Revisar para copiar é uma proteção de interface. A aprovação de mensagens ainda não é persistida/auditada; uma futura integração deverá validar aprovação no backend.
- Até 5.000 registros/2 MB por importação, com erro explícito, sem corte silencioso. A listagem busca todas as páginas de 200 registros; volume grande exigirá paginação visual e busca no servidor.
- A identidade provisória não é CNPJ: nomes semelhantes podem exigir revisão manual. Alterações de identidade no backup com novo ID podem exigir reconciliação manual; a aplicação não tenta adivinhar se são a mesma empresa.
- Exportação v1 não é backup integral do banco. Paginação não fornece snapshot transacional de exportação sob alterações concorrentes; faça backup PostgreSQL para consistência completa.
- Logout limpa a sessão local e tenta revogar o refresh token no provedor. Se a rede falhar, isso é informado. JWTs já emitidos seguem a validade do Auth.
- Restauração real de banco e integração com Supabase hospedado ainda exigem homologação autorizada.

## Verificação local

Testes executam PostgreSQL temporário em memória, autenticação/API simuladas e navegador com HTTP simulado. Não há segredo de produção, seed comercial, migração automática, script de deploy ou integração de pagamento.

## Recuperação de senha

O fluxo de recuperação tem cookies e autorização separados do login do painel. A identidade é validada remotamente com Supabase Auth antes de interpretar os claims do JWT. Exige método `recovery` recente, expiração válida e correspondência do usuário/sessão ao renovar o token antes de alterar a senha. Não aceita uma sessão comum como prova de recuperação. Cookies de recuperação expiram em até 15 minutos e não são promovidos a uma sessão comercial.

Senhas e provas não são registradas nem persistidas em armazenamento JavaScript. Callbacks são limpos antes da montagem do React; erros da URL e do provedor não são reproduzidos em tela. O transporte do SDK é limitado por timeout e recebe erros genéricos quando o fetch lança exceção, evitando logs internos com detalhes da requisição. Regras de origem e JSON continuam obrigatórias. Detalhes e testes em [PASSWORD_RECOVERY.md](PASSWORD_RECOVERY.md).
