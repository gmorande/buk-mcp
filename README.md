# Buk MCP

Servidor MCP comunitario para conectar **Buk Chile** con ChatGPT, Dots y otros clientes MCP. Incluye el catálogo completo de la API oficial indicada abajo y herramientas para **historial salarial, remuneraciones, costo de equipos y comparación con el IPC**.

Cada empresa utiliza su propia URL de Buk y su propia API key. El proyecto se puede autoalojar; el modo OAuth permite que varias empresas conecten sus credenciales por separado a un mismo servidor. No necesitas una API key de OpenAI para ejecutar el adaptador.

**Integración independiente, sin afiliación ni aprobación de Buk.** Este repositorio contiene código y datos públicos del IPC; no contiene claves ni datos de empleados. Publicar el código no publica un servicio alojado ni lo instala automáticamente en ChatGPT o Todd.

## Qué incluye

- **206 operaciones documentadas** en el esquema oficial de Chile: **119 GET** y **87 operaciones de escritura**. El catálogo se genera del esquema, sin mantener manualmente una lista parcial de rutas.
- Descubrimiento de operaciones, parámetros, permisos y esquemas de respuesta. Puedes consultar cualquier endpoint documentado a través de las herramientas genéricas.
- Sueldo base histórico, aumentos, jornada, moneda y liquidaciones por período.
- Costo mensual de equipos según la fórmula estándar de Buk, con aportes observados, desglose por persona, haberes fijos/ocasionales y comparación mensual.
- Simulación de cambios del sueldo base sin modificar Buk.
- Comparación del sueldo con la serie mensual empalmada del **INE de Chile**.
- Paginación, validación de parámetros, límites de tamaño, timeout, reintentos de lectura y errores con permisos o cobertura incompleta explícitos.
- Transporte **stdio** y **Streamable HTTP**. HTTP ofrece OAuth con PKCE para varias empresas, o bearer fijo para una instalación aislada.
- Pruebas de protocolo MCP, API, cálculos, autenticación y separación de empresas; CI para Node 22 y 24.

Las escrituras están **desactivadas por defecto** y no están disponibles en OAuth compartido. Una instalación aislada puede habilitarlas explícitamente. La cobertura del catálogo no elimina los permisos de la API key ni las restricciones de módulos contratados.

## Inicio rápido: cliente MCP local

Requisitos: **Node.js 22 o superior** y una API key de Buk. Para sueldos se requieren permisos de lectura de remuneraciones y acceso a información sensible.

```sh
git clone https://github.com/gmorande/buk-mcp.git
cd buk-mcp
npm ci
npm run build
```

En la configuración del cliente MCP, agrega el proceso con una ruta absoluta. Sustituye los valores de ejemplo en un archivo privado del cliente:

```json
{
  "mcpServers": {
    "buk": {
      "command": "node",
      "args": ["/ruta/absoluta/buk-mcp/dist/index.js", "stdio"],
      "env": {
        "BUK_TENANT_URL": "https://tuempresa.buk.cl",
        "BUK_API_KEY": "TU_CLAVE_PRIVADA",
        "BUK_COUNTRY": "chile",
        "BUK_ALLOW_WRITES": "false"
      }
    }
  }
}
```

La clave va en la configuración privada o gestor de secretos. No debe aparecer en prompts, argumentos de herramientas, commits o issues.

También puedes preparar un `.env` a partir de `.env.example` y usar:

```sh
node --env-file=.env dist/index.js stdio
```

El proceso stdio se comunica con un cliente MCP mediante stdin/stdout; no es una consola interactiva de preguntas.

## ChatGPT, Todd y un servicio para varias empresas

Para clientes cloud utiliza el modo HTTP con OAuth, detrás de HTTPS:

```dotenv
BUK_AUTH_MODE=oauth
PUBLIC_URL=https://mcp.tudominio.cl
HOST=127.0.0.1
PORT=3000
OAUTH_DATA_DIR=/var/lib/buk-mcp
OAUTH_MASTER_KEY=32_BYTES_ALEATORIOS_CODIFICADOS_EN_BASE64
OAUTH_REDIRECT_URIS=https://chatgpt.com/connector_platform/oauth_redirect
```

```sh
node --env-file=.env dist/index.js http
```

Registra `https://mcp.tudominio.cl/mcp` como MCP personalizado con OAuth en el cliente. La página de conexión solicita la URL y la API key de **esa empresa**, las verifica y guarda la credencial cifrada. El token OAuth queda vinculado a esa conexión; cada solicitud usa su propio cliente Buk.

El operador del servicio puede acceder a los datos autorizados por esas claves: cada empresa debe elegir un operador de confianza o autoalojar. La implementación incluida usa **un proceso y una réplica** con almacenamiento cifrado persistente. La guía explica HTTPS, callbacks, rotación, revocación, límites y despliegue con Docker.

**Guía completa:** [DEPLOYMENT.md](docs/DEPLOYMENT.md). La conexión personalizada y la admisión en el catálogo público de ChatGPT son procesos distintos; el proyecto no afirma tener aprobación del catálogo.

## Preguntas de ejemplo

Sustituye **X** por una persona y especifica el período cuando sea relevante. El asistente debe resolver la ficha correcta y aclarar nombres de equipo ambiguos. “Tech” es un ejemplo de área: cada empresa utiliza su propia estructura.

Estas son las preguntas que ejecuta la suite `test:live`. El informe de verificación distingue éxito, datos parciales y fallos; no contiene los resultados de RR.HH.

| ID | Pregunta | Herramienta principal |
| --- | --- | --- |
| Q01 | Busca a X y dime si tiene más de una ficha. | `buk_search_employees` |
| Q02 | Muéstrame las áreas y subáreas de la organización. | `buk_read` → áreas |
| Q03 | ¿Cuánto me costó mensualmente el equipo Tech en el último mes cerrado? Dame el total y el desglose por persona. | `buk_team_payroll` |
| Q04 | Separa los haberes fijos, ocasionales y aportes patronales del equipo Tech. | `buk_team_payroll` |
| Q05 | ¿Cómo cambió el costo de Tech frente al mes anterior y cuántas personas o fichas había en cada mes? | `buk_team_payroll` con comparación |
| Q06 | ¿Quiénes integraban Tech a una fecha determinada y cuánto sumaban sus sueldos base mensuales? | `buk_recurring_payroll` |
| Q07 | Si subo 5% los sueldos base de Tech, ¿cuánto aumenta mensualmente esa suma? | `buk_recurring_payroll` con escenario |
| Q08 | Dame la evolución histórica del sueldo de X, con las fechas y porcentajes de sus aumentos. | `buk_salary_history` |
| Q09 | Compara la evolución del sueldo base de X con el IPC. ¿Ganó o perdió poder adquisitivo? | `buk_salary_history` con IPC |
| Q10 | ¿Cuánto tuvo X de haberes brutos, descuentos y líquido en un mes determinado? | `buk_read` → liquidaciones de la ficha |
| Q11 | ¿Cuántos días de vacaciones tenía X a una fecha determinada, descontando las vacaciones futuras registradas? | `buk_read` → saldo de vacaciones |
| Q12 | ¿Qué empresas o razones sociales puede consultar esta conexión? | `buk_read` → empresas |

La verificación comprueba las llamadas y los cálculos necesarios para responder. No es una promesa de que cualquier modelo responda correctamente a cualquier redacción ni una prueba de todos los endpoints contra producción.

## Herramientas MCP

El servidor mantiene pocas herramientas y descubre el catálogo completo bajo demanda. No obliga al cliente a cargar 206 descripciones a la vez.

| Herramienta | Función |
| --- | --- |
| `buk_list_operations` | Buscar operaciones por texto, módulo/tag y método; listar el catálogo con paginación. |
| `buk_describe_operation` | Obtener parámetros, permisos y esquemas oficiales antes de una llamada. |
| `buk_read` | Ejecutar cualquier GET documentado con validación y paginación. |
| `buk_write` | Ejecutar operaciones de escritura; sólo aparece cuando el servidor aislado las habilita. |
| `buk_search_employees` | Encontrar personas y fichas, señalando coincidencias ambiguas. |
| `buk_team_payroll` | Calcular remuneraciones y costo de un equipo para un mes; comparar períodos. |
| `buk_salary_history` | Consultar sueldo base histórico, liquidaciones y comparación opcional con IPC. |
| `buk_recurring_payroll` | Sumar sueldo base vigente a una fecha y simular variaciones porcentuales. |
| `buk_compare_salary_to_cpi` | Comparar dos sueldos en CLP con índices oficiales de dos meses. |

También ofrece los recursos `buk://api/catalog`, `buk://schema/chile` y `buk://guide/payroll`, más prompts para costo de equipo e historial salarial.

### Ejemplo de llamada

Primero descubre y describe la operación; sus parámetros y formatos de fecha pueden variar.

```json
{
  "name": "buk_read",
  "arguments": {
    "operationId": "get_employees_id_jobs",
    "path": { "id": "123" },
    "paginate": true
  }
}
```

```json
{
  "name": "buk_team_payroll",
  "arguments": {
    "team": "Tech",
    "month": "2026-09",
    "compare_previous": true
  }
}
```

Los IDs de operación se derivan del método y la ruta. El catálogo del servidor es la autoridad; el ejemplo de ficha `123` es ficticio.

## Cómo calcula sueldos y costos

**Costo estándar Buk:** total de haberes + aportes patronales observados − asignación familiar. El servidor verifica los componentes de la liquidación y su reconciliación. La ausencia de aportes no se transforma silenciosamente en cero. Los ítems informativos, como el saldo acumulado de una provisión, no se suman como gastos mensuales.

**Costo contable personalizado:** si la empresa usa otra definición, `expense_accounts` permite indicar las cuentas de gasto aprobadas. Suma débitos menos créditos de esas cuentas, evitando sumar pasivos o contrapartidas. El mapeo requiere validación de Finanzas. No se mezclan automáticamente los dos métodos.

**Historia y pertenencia a equipos:** usa trabajos con fechas efectivas para el mes consultado. Un cambio de área dentro del mes se señala como provisional; para una distribución exacta se necesitan los centros de costo correspondientes. La jerarquía de áreas puede ser la actual: si hubo una reorganización histórica, usa `area_ids` explícitos e `include_descendants=false`.

**Sueldo vigente:** la proyección de sueldo base excluye bonos, gratificaciones, aportes y otros componentes. El escenario de 5% representa ese aumento del sueldo base; no estima de forma implícita todas las cargas adicionales.

**IPC:** calcula `(sueldo final / sueldo inicial) / (IPC final / IPC inicial) - 1`, con meses coincidentes. Descarga la serie mensual empalmada del INE y conserva una copia pública fechada como respaldo. Si falta el mes solicitado, no inventa el dato. Usa los niveles publicados del índice; el redondeo puede producir pequeñas diferencias frente a una calculadora con precisión interna adicional.

Siempre separa monedas, sueldos base, bruto, descuentos, líquido y costo empresa. `income_net` es el líquido indicado por Buk, no una confirmación de transferencia bancaria. Costos de proveedores, contratistas o beneficios fuera de Buk requieren otra fuente.

Detalles, supuestos y límites: [ANALYTICS.md](docs/ANALYTICS.md).

## Cobertura de la API

Fuente oficial: [Swagger de Buk Chile](https://demo.buk.cl/api/chile/es/api_docs), visible en [apidocs](https://demo.buk.cl/apidocs). Snapshot: **23 de octubre de 2026**.

| Método | Operaciones |
| --- | ---: |
| GET | 119 |
| POST | 46 |
| PUT | 6 |
| PATCH | 18 |
| DELETE | 17 |
| **Total** | **206** |

La cobertura significa que cada operación del esquema tiene un ID, descripción, esquema de entrada y un camino de ejecución. Los módulos o endpoints privados, de otros países, de otros productos Buk o ausentes del documento suministrado no se inventan ni se presentan como verificados.

El documento oficial contiene algunas inconsistencias y una referencia de respuesta sin definición. Las normalizaciones y la lista completa de rutas están en [API_COVERAGE.md](docs/API_COVERAGE.md). El esquema original se conserva íntegro en `schema/buk-chile.json`.

Para actualizarlo:

```sh
npm run schema:update
npm run check
```

Revisa el diff antes de incorporar cambios del contrato. La actualización de esquema no ejecuta escrituras en Buk.

## Pruebas

**Verificación del 23 de octubre de 2026:** las **12 preguntas del README** pasaron con una cuenta real de Buk Chile, usando un cliente MCP por stdio. Se comprobaron consultas y conciliaciones matemáticas, exclusivamente en lectura. El [informe anonimizado](docs/verification.json) contiene los estados y comprobaciones. Los datos reales, la clave y la identidad del cliente no están incluidos.

```sh
npm ci
npm run check
```

La suite local usa fixtures ficticios. Comprueba todos los esquemas, validación, paginación, formatos de solicitud, límites, reintentos, errores, matemáticas, OAuth/PKCE, revocación, aislamiento de empresas y llamadas MCP reales por transportes de prueba. GitHub Actions ejecuta estas pruebas sin credenciales Buk.

Para verificar las 12 preguntas con una cuenta autorizada, configura tu `.env` privado y ejecuta:

```sh
BUK_LIVE_TEAM=Tech BUK_LIVE_MONTH=2026-09 \
node --env-file=.env --import tsx scripts/live-test.ts
```

Puedes definir `BUK_LIVE_EMPLOYEE_ID` y `BUK_LIVE_START_MONTH`. Por defecto, el script elige una ficha con historial accesible y usa el mes anterior. Si necesitas un informe, indica `BUK_LIVE_REPORT=/ruta/informe.json`; sólo escribe preguntas, estados, comprobaciones y códigos de limitación. No guarda respuestas de Buk. El script fuerza lectura y falla si el servidor expone una herramienta de escritura.

Si hay áreas activas e históricas con el mismo nombre, usa `BUK_LIVE_TEAM` con un nombre único de la jerarquía. Las herramientas devuelven candidatos cuando el nombre es ambiguo; no mezclan automáticamente áreas homónimas.

Un fallo de permisos, un período abierto o datos incompletos no se reportan como éxito. Las pruebas de escritura usan simulaciones; no alteran datos reales para comprobar el catálogo.

## Seguridad y contribuciones

Consulta [SECURITY.md](SECURITY.md). Antes de abrir un issue, elimina claves, dominios privados, nombres, RUT, montos y respuestas completas. Adjunta una reproducción con datos ficticios.

Las mejoras deben conservar la separación por empresa, la trazabilidad de cálculos y las señales de cobertura. Una nueva operación debe venir del esquema oficial; un nuevo cálculo financiero necesita una definición explícita y pruebas de los casos que podrían cambiar su resultado.

Licencia del código: [MIT](LICENSE). Los esquemas y series públicas incluidos mantienen la atribución a Buk y al INE; la licencia del código no reemplaza sus condiciones de uso.
