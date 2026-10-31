# Creative Studio em HTTP local e HTTPS

## Correção da tela preta

O erro `crypto.randomUUID is not a function`, ao abrir um projeto como “Black Tech Teste”, ocorria porque essa API depende de contexto seguro. HTTP em localhost é uma exceção confiável do navegador; HTTP em um IP como `192.168.18.7` não é. HTTPS com certificado confiável também é considerado seguro.

As nove chamadas diretas no frontend foram substituídas por `createRequestId`, em `src/request-id.ts`:

- `BriefEditor.tsx`: preparação e salvamento de rascunhos;
- `NewProject.tsx`: criação e repetição idempotente de projetos;
- `SiteGenerationPanel.tsx`: solicitação e repetição idempotente de geração;
- `SiteExportPanel.tsx`: solicitação e repetição idempotente de revisão.

O helper usa **sempre** `crypto.getRandomValues`, disponível também em contextos HTTP não seguros nos navegadores compatíveis. Gera 16 bytes criptográficos e aplica os bits de versão/variante de UUID v4 (RFC 9562), preservando 122 bits aleatórios. Não usa `Math.random`, relógio, contador, armazenamento local ou fallback previsível. Se a fonte criptográfica faltar ou falhar, a operação é interrompida com uma mensagem segura.

Esses UUIDs são chaves de requisição/idempotência. Não substituem tokens de sessão, PKCE, IDs de autorização ou a geração de IDs no banco. Backend, autenticação, CSRF, cookies, RLS e verificações de versão/hash não foram alterados. As regras de reutilização da mesma chave em uma repetição continuam preservadas.

## Tratamento de falha visual

`UiErrorBoundary` protege o painel Creative Studio, mantendo a navegação do workspace disponível se um componente falhar durante renderização/ciclo de vida. Uma segunda barreira cobre a raiz da aplicação. A interface mostra orientação e uma ação explícita **Tentar abrir novamente**, sem apresentar mensagens técnicas, props ou stacks. O callback de erros capturados do React não registra os objetos de erro.

A recuperação remonta o painel; alterações não salvas podem ter sido perdidas. O usuário deve conferir a versão persistida antes de continuar. Não há aprovação, reenvio, gravação ou navegação automática causada pela barreira. Ela não captura erros de handlers/Promises arbitrários; as operações assíncronas mantêm seus próprios tratamentos existentes.

## Outras APIs e limites

| API/funcionalidade                         | HTTP no IP privado                                                                      | HTTPS confiável ou localhost                               |
| ------------------------------------------ | --------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `crypto.getRandomValues` / UUIDs do Studio | Disponível em navegadores compatíveis; sem enfraquecer a aleatoriedade                  | Disponível                                                 |
| `crypto.randomUUID`                        | Não é necessária pelo frontend após esta correção                                       | Também não é necessária                                    |
| `crypto.subtle.digest` / SHA-256 do ZIP    | Pode não existir; o download fica bloqueado com explicação                              | Download permitido após revisão e validação de integridade |
| `navigator.clipboard.writeText`            | Pode não existir ou exigir permissão; a interface já orienta copiar o texto manualmente | Continua sujeita a permissão/gesto do usuário              |

A prévia e a revisão de uma versão permanecem disponíveis sem `crypto.subtle`. O painel explica a necessidade de HTTPS/localhost e desabilita o download quando não pode verificar o SHA-256. A função de download também bloqueia a requisição antes de fazer fetch nesse cenário. Não há exportação sem verificação de integridade nem implementação criptográfica improvisada para contornar a exigência.

HTTP na LAN **não cifra** login ou cookies no trajeto. Esta correção não fornece TLS, certificado ou autorização para expor o aplicativo na internet. Mantenha a rede confiável e as regras exatas de origem da [configuração local](LOCAL_NETWORK.md). Para o fluxo completo com download no PC 2, use HTTPS local com certificado confiável em ambos os PCs em uma etapa própria. Não use flags do Chrome para desabilitar segurança ou tratar uma origem HTTP como segura.

## Verificação local

Com os arquivos atualizados, preserve `.dev.vars` e suas credenciais existentes. Reinicie somente os processos Vite/Wrangler do projeto para garantir que os dois frontends usem o novo bundle. Não é necessário aplicar migrações ou alterar configurações Supabase.

1. No PC 1, abra `http://localhost:5173`; no PC 2, abra `http://192.168.18.7:5173`.
2. Entre normalmente, abra Creative Studio e selecione **Black Tech Teste**.
3. Confirme que o briefing abre. Edite e salve somente dados de homologação autorizados; recarregue e confira a versão salva.
4. Se houver uma versão de site de homologação, abra a prévia e selecione Desktop/Tablet/Celular. A revisão continua explícita por versão.
5. Em HTTP no IP, espere o aviso de integridade/HTTPS e o ZIP bloqueado quando `crypto.subtle` faltar. Em localhost/HTTPS, o download deve continuar exigindo revisão e conferência dos hashes.

Testes automatizados:

```bash
npm run check
npm run format:check
npm run test:e2e -- tests/e2e/studio.spec.ts tests/e2e/studio-generation.spec.ts tests/e2e/studio-preview.spec.ts tests/e2e/studio-export.spec.ts tests/e2e/lan-origins.spec.ts
```

Os testes de navegador usam o build real sob CSP restritiva e API simulada. Reproduzem HTTP no IP com `isSecureContext === false`, ausência de `randomUUID`, abertura de “Black Tech Teste”, criação/salvamento, HTTPS, recuperação da barreira de erro e bloqueio de exportação sem SHA-256. Os fluxos de geração e exportação também são exercitados com `randomUUID` removida. Nenhuma flag de contexto inseguro é usada. Esses testes não acessam os dois PCs físicos nem Supabase remoto. Os testes SQL existentes usam somente banco descartável em memória.
