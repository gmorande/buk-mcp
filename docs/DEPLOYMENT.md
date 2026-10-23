# Desplegar Buk MCP

Esta versión incluye tres formas de usar el mismo servidor: `stdio`, HTTP con bearer para una sola empresa y HTTP con OAuth para conexiones independientes de varias empresas. El catálogo de operaciones incluido corresponde a **Buk Chile**. La integración es comunitaria y no está afiliada a Buk.

## Elegir un modo

| Modo | Dónde se guarda la API key Buk | Cliente |
| --- | --- | --- |
| `stdio` | Variables de entorno del proceso que inicia el cliente | Clientes MCP locales que ejecutan procesos |
| HTTP `bearer` | Secretos del despliegue; una empresa | Clientes que admiten `Authorization: Bearer …` fijo |
| HTTP `oauth` | Almacén cifrado del servidor; una conexión por autorización | ChatGPT/Dots y clientes MCP con OAuth + PKCE + registro dinámico |

El token del conector y la API key Buk son credenciales distintas. No se introduce una API key en una conversación ni como argumento de herramientas MCP.

## Preparar Buk

Un administrador debe habilitar el módulo API, crear una API key exclusiva para esta integración y seleccionar las empresas permitidas. Se recomienda empezar con lectura. Para consultar remuneraciones, la clave necesita los permisos correspondientes y acceso a datos sensibles. La conexión OAuth comprueba la clave mediante una consulta de empleados; no conserva el resultado de esa comprobación.

Verificar los métodos y permisos en `https://TU-EMPRESA.buk.cl/apidocs`. Una API key no hace accesible una función que el cliente no tiene contratada.

## Instalar

Requisitos: Node.js 22 o superior y un volumen persistente si se usa OAuth.

```sh
npm ci
npm run build
```

Usar el archivo de dependencias bloqueadas del repositorio. No se necesita una clave OpenAI para ejecutar este adaptador.

## OAuth para ChatGPT y Dots

### 1. Configurar el servidor

Configurar estos valores mediante el gestor de secretos del alojamiento o un archivo `.env` local excluido de Git:

```dotenv
BUK_AUTH_MODE=oauth
PUBLIC_URL=https://mcp.example.com
HOST=127.0.0.1
PORT=3000
OAUTH_DATA_DIR=/var/lib/buk-mcp
OAUTH_MASTER_KEY=REEMPLAZAR_CON_32_BYTES_ALEATORIOS_EN_BASE64
OAUTH_REDIRECT_URIS=https://chatgpt.com/connector_platform/oauth_redirect
```

Generar una clave maestra de 32 bytes aleatorios, codificados en base64. Por ejemplo, `openssl rand -base64 32`; introducir el resultado directamente en el gestor de secretos. Conservarla entre despliegues. El arranque falla si la clave no tiene el formato correcto o no permite descifrar el almacén existente; no reemplaza silenciosamente los datos.

`OAUTH_REDIRECT_URIS` es una lista separada por comas de **URLs de retorno exactas**. Agregar el callback que anuncie cada cliente confiable. No se admiten comodines, fragmentos, credenciales en URLs ni HTTP externo. El registro dinámico no puede ampliar esta lista. El valor predeterminado es el callback de ChatGPT mostrado arriba; comprobarlo contra el flujo de conexión vigente de la cuenta. Para pruebas locales puede autorizarse explícitamente un callback `http://127.0.0.1:PUERTO/callback`.

En este modo no se configura `BUK_API_KEY` global. Cada autorización crea una conexión distinta y el servidor obtiene la credencial correspondiente al token autenticado. Las escrituras están deshabilitadas, aunque una clave Buk tenga permiso de edición. `BUK_ALLOW_WRITES=true` hace fallar el arranque OAuth.

Iniciar con los secretos ya presentes en el entorno:

```sh
node dist/index.js http
```

Para desarrollo con un archivo `.env` excluido de Git:

```sh
node --env-file=.env dist/index.js http
```

### 2. Publicar HTTPS

Colocar el proceso detrás de un proxy TLS y mantener `PUBLIC_URL` igual al origen externo. El servidor valida el encabezado Host y, cuando viene presente, Origin. El proxy debe preservar Host; no se confía en encabezados `X-Forwarded-*` arbitrarios.

Ejemplo de Caddy, sustituyendo el dominio:

```caddyfile
mcp.example.com {
    reverse_proxy 127.0.0.1:3000 {
        header_up Host {host}
    }
}
```

No registrar cuerpos de solicitudes, cookies ni Authorization en el proxy. Los cuerpos de `/authorize/complete` contienen la clave Buk y los de `/token` y `/revoke` contienen secretos OAuth. El servidor no registra esos valores. Configurar los límites de acceso del proxy sin incluirlos en los registros.

El endpoint MCP es `https://mcp.example.com/mcp`, con Streamable HTTP sin sesiones persistentes y respuesta JSON. Cada POST crea su propio cliente Buk, servidor MCP y transporte. GET y DELETE en `/mcp` devuelven 405 deliberadamente: esta versión no ofrece flujos SSE permanentes ni sesiones que cerrar.

HTTP sin TLS sólo está permitido para `localhost` o `127.0.0.1`, y el iniciador rechaza exponer ese modo en una interfaz no local. En contenedores detrás de TLS puede usarse `HOST=0.0.0.0` con `PUBLIC_URL` HTTPS y una red privada entre proxy y contenedor.

### 3. Conectar

En ChatGPT: **Plugins → + → Add custom MCP server**. Introducir la URL `/mcp`, configurar OAuth y crear el plugin. Instalarlo y completar la conexión. La disponibilidad del control depende de los permisos de la cuenta/workspace.

El servidor ofrece descubrimiento de autorización y recurso protegido, registro dinámico, autorización con PKCE S256, intercambio de código, renovación y revocación. La página de autorización muestra el cliente y su origen de retorno. El administrador ingresa directamente allí la URL Buk y una clave dedicada; la clave viaja al servidor y no se entrega al modelo. El operador del servidor sí puede usarla para acceder a los datos autorizados: elegir un operador de confianza o autoalojar.

Probar una consulta conocida desde una conversación nueva. Después, pedir la misma consulta a Todd y verificar que el trabajo se ejecute en su entorno cloud. Que un MCP funcione en un cliente local no demuestra por sí solo que quedó conectado a Dots.

No alcanza con importar un `.mcp.json` local para obtener un plugin cloud: la documentación de ChatGPT marca ese tipo de plugins importados como Desktop only, incluso con URLs HTTPS.

### Credenciales, sesiones y almacenamiento

- Credenciales Buk y datos OAuth se guardan en `oauth-state.enc`, cifrados con AES-256-GCM y una clave externa al archivo. Los access/refresh tokens se almacenan como digests SHA-256.
- Directorio con modo `0700` y archivo con modo `0600`; escrituras mediante reemplazo atómico.
- Access tokens: una hora. Refresh tokens: 30 días de vida absoluta, con rotación. Reutilizar un refresh token ya usado revoca la familia y elimina la credencial de esa conexión.
- Códigos de autorización: dos minutos y un solo uso. Formularios pendientes: diez minutos, cookie HttpOnly/SameSite y comprobación de Origin/CSRF.
- Los códigos y formularios pendientes no sobreviven a reinicios; las conexiones y tokens vigentes sí. Si se reinicia durante la conexión, iniciarla de nuevo.
- Revocar un token de la conexión mediante `/revoke` revoca su familia y elimina esa credencial. También se puede invalidar inmediatamente el acceso en Buk eliminando la API key dedicada.
- No hay copia de una base de datos de RR.HH. Las herramientas consultan Buk a demanda. El almacén sí contiene credenciales y metadatos de autorización, por lo que sus copias de respaldo requieren el mismo cuidado.

**Límite de esta implementación:** una réplica y un solo proceso por directorio de datos. No compartir el archivo con varios procesos, no activar `cluster`/múltiples workers ni escalado horizontal. El estado se mantiene en memoria con persistencia cifrada en archivo; no tiene transacciones entre procesos. Para un servicio central de mayor escala, reemplazarlo por almacenamiento transaccional y un gestor de secretos, y usar límites de tráfico compartidos antes de escalar. Existen topes de clientes, conexiones, formularios y tokens; cuando se alcanzan, se rechazan nuevas operaciones en vez de crecer sin límite.

Los límites por IP del SDK ven la IP del proxy, porque no se aceptan encabezados de IP de terceros sin verificar. Esto los vuelve conservadores detrás de un proxy compartido. Para alto volumen, configurar conscientemente la topología del proxy y límites compartidos; no habilitar `trust proxy=true` de forma indiscriminada.

Los cuerpos MCP se leen después de autenticar la solicitud: hasta 256 KiB en lectura y hasta 16 MiB en un despliegue bearer que habilite escrituras, para admitir el archivo de hasta 10 MiB codificado en base64 que soporta el cliente Buk. Los metadatos de registro OAuth están limitados a 4 KiB por cliente.

## HTTP bearer para una empresa

Este modo sirve a clientes capaces de enviar un bearer fijo. No sustituye el flujo OAuth requerido por la conexión de ChatGPT documentada arriba.

```dotenv
BUK_AUTH_MODE=bearer
PUBLIC_URL=https://mcp.example.com
HOST=127.0.0.1
PORT=3000
BUK_MCP_ACCESS_TOKEN=TOKEN_ALEATORIO_DISTINTO_DE_LA_CLAVE_BUK_MINIMO_32_CARACTERES
BUK_TENANT_URL=https://tuempresa.buk.cl
BUK_API_KEY=CLAVE_DEDICADA_BUK
BUK_COUNTRY=chile
BUK_ALLOW_WRITES=false
```

El cliente envía `Authorization: Bearer <BUK_MCP_ACCESS_TOKEN>`. No existe acceso anónimo. Este token de despliegue no tiene renovación ni caducidad automática: rotarlo manualmente y restringir quién lo recibe. Para expiración y renovación por conexión, usar OAuth.

Sólo habilitar `BUK_ALLOW_WRITES=true` deliberadamente en una instalación aislada, con una clave Buk y usuarios autorizados para modificar información. Un servidor con escrituras necesita además controles y revisión operativa adecuados a esas acciones; no usar una clave compartida de escritura en un servicio público.

## Verificar el despliegue

1. `/healthz` devuelve sólo el estado técnico, sin datos de empleados ni secretos.
2. `/mcp` sin credencial devuelve 401; OAuth incluye el enlace a metadatos del recurso.
3. Una URL de retorno no autorizada, un Origin desconocido y un Host falso son rechazados.
4. Dos conexiones de empresas diferentes producen resultados de sus respectivas cuentas. No reutilizar un cliente Buk global entre solicitudes.
5. Comparar algunas consultas con Buk: identidad de empleado, período, moneda, datos sensibles y paginación completa.
6. Revocar una conexión y comprobar que su token ya no funciona.

Las pruebas automatizadas de OAuth/HTTP usan datos ficticios. No realizan solicitudes a Buk ni prueban credenciales reales.

## Distribuir el MCP y publicar en el catálogo

Compartir el código para autoalojamiento o documentar la URL de un servicio para conexiones personalizadas es distinto de aparecer en el catálogo público de ChatGPT. No se ha solicitado ni obtenido aprobación del catálogo para este proyecto.

Las guías oficiales del catálogo restringen conectores no oficiales de terceros y la recopilación de secretos. El portal tampoco ofrece un flujo de conexión con API key fija. La autenticación OAuth de este proyecto resuelve la conexión técnica del cliente MCP; no implica aprobación de la distribución pública ni una excepción automática a esas reglas. Antes de solicitar publicación oficial, validar autorización de Buk y admisibilidad del flujo de credenciales con OpenAI.

Referencias consultadas:

- [Conectar un MCP personalizado a ChatGPT](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [Autenticación de plugins](https://developers.openai.com/plugins/build/auth)
- [Requisitos del catálogo](https://developers.openai.com/plugins/plugin-guidelines)
- [Limitaciones del portal de publicación](https://developers.openai.com/plugins/deploy/submission)
- [Conectar apps a Dots](https://learn.chatgpt.com/docs/dots/computers-and-apps)
- [Plugins importados y Desktop only](https://learn.chatgpt.com/docs/enterprise/plugin-management)
- [SDK TypeScript MCP: transporte, autenticación y protección de Host](https://ts.sdk.modelcontextprotocol.io/server)

