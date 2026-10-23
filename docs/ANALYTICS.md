# Sueldos, historial y costo de personas

Los cálculos se realizan con decimales y devuelven montos como strings. El MCP nunca
suma monedas diferentes en un único total. Cada resultado incluye fuentes,
cobertura y advertencias materiales; el cliente debe presentar esas limitaciones.

## Herramientas

| Herramienta | Uso |
| --- | --- |
| `buk_search_employees` | Resolver una persona por nombre, correo o ficha antes de consultar sus datos salariales. |
| `buk_team_payroll` | Nómina de un mes, costo empresa estándar de Buk, desglose por persona, componentes fijos/ocasionales, comparación mensual y centralización opcional. |
| `buk_salary_history` | Trabajos con vigencia, cambios de sueldo base, liquidaciones históricas y comparación opcional con IPC. |
| `buk_recurring_payroll` | Masa de sueldos base de la dotación vigente a una fecha y escenarios porcentuales. |
| `buk_compare_salary_to_cpi` | Comparación de dos salarios CLP con los índices empalmados oficiales del INE. |

### Ejemplo: costo mensual de Tech

```json
{
  "name": "buk_team_payroll",
  "arguments": {
    "month": "2026-09",
    "team": "Tech",
    "compare_previous": true
  }
}
```

El nombre de un área se busca primero por coincidencia exacta, ignorando mayúsculas
y tildes. Si coincide más de un área o no hay coincidencias, la herramienta devuelve
candidatos y no inventa la selección. `area_ids` permite una selección explícita;
`include_descendants` incluye subáreas usando la jerarquía disponible.

## Qué significa “costo empresa”

Buk publica esta fórmula para Chile:

**Costo empresa = total haberes + aportes patronales − asignación familiar.**

La implementación la calcula desde cada liquidación:

1. Reconcilia la suma de las líneas `type=haber` con `income_gross`.
2. Suma las líneas `type=aporte`, incluyendo ajustes presentes en esa liquidación.
3. Resta la asignación familiar identificada por su código estándar o nombre exacto.
4. Suma los resultados de las liquidaciones incluidas, por moneda.

Si faltan líneas de aportes no se supone un aporte de cero. Si los haberes no
reconcilian o aparece una variante no reconocida de asignación familiar, el costo
total queda sin determinar y se informa el problema. `family_allowance_codes`
permite indicar los códigos de un concepto específico de la empresa. Los ítems
`informativo` no se suman automáticamente: podrían ser saldos, provisiones diarias o
conceptos ya incluidos en otra parte.

El resultado es el costo estándar de remuneraciones de Buk. Beneficios externos,
contratistas y provisiones adicionales no se incorporan si no están en las fuentes
consultadas. Para una definición interna distinta, se puede usar la centralización
contable.

Fuente: [Costo empresa en Buk](https://supportcenter.buk.cl/hc/es-419/articles/36330030950427-Costo-empresa-en-Buk).

### Alternativa contable

`expense_accounts` acepta las cuentas de gasto de personas que Finanzas haya
definido. El cálculo es **débitos − créditos** exclusivamente en esas cuentas. No se
suman todas las partidas: eso mezclaría gasto, pasivos, bancos y contrapartidas.
`include_accounting=true` permite inspeccionar el resumen de cuentas sin asignarles
automáticamente un significado.

```json
{
  "month": "2026-09",
  "area_ids": [10],
  "expense_accounts": ["CUENTA_GASTO_SUELDOS", "CUENTA_GASTO_APORTES"],
  "include_accounting": true
}
```

Los identificadores anteriores son marcadores, no códigos de una empresa real.
Las partidas de contabilidad ya distribuidas por centro de costo no se multiplican
nuevamente por los porcentajes del trabajo. Para subtotales salariales filtrados
por centro de costo se utilizan los porcentajes del trabajo histórico y se exige
que sumen 100.

## Reglas de período, dotación y moneda

- El mes se pasa explícitamente como `YYYY-MM`.
- Por defecto se incluyen liquidaciones cerradas. Las abiertas o de estado
  desconocido se cuentan como exclusiones y hacen que la cobertura no sea completa.
  `include_open=true` las incluye marcando el resultado como provisional.
- La pertenencia a un equipo se determina con el trabajo que estuvo vigente en el
  mes consultado. No se aplica el área actual de la persona a toda su historia.
- Si hubo traslado dentro del mes, la liquidación completa se asigna al último
  trabajo vigente y el resultado queda señalado como provisional, también para el
  equipo de origen. Una distribución exacta requiere partidas o centros de costo
  con el detalle apropiado.
- La jerarquía de áreas es la que devuelve hoy Buk. Para reconstruir una
  reorganización histórica, se deben especificar los `area_ids` del período y
  `include_descendants=false`.
- Los IDs de liquidación se deduplican. Si un mismo ID aparece con importes
  diferentes, se informa el conflicto; las fichas distintas de una persona no se
  fusionan por nombre.
- La API chilena puede omitir la moneda de la liquidación. `payroll_currency`
  declara la moneda de esos registros y vale `CLP` por defecto. La moneda del
  sueldo base contractual se informa por separado y no se usa como conversión.
- Sueldo líquido indica el importe de la liquidación, no evidencia de una
  transferencia bancaria realizada.
- Si no se recuperaron todas las páginas, los subtotales se identifican como
  parciales. No se presentan como costo definitivo.

## Historial e IPC

```json
{
  "name": "buk_salary_history",
  "arguments": {
    "employee_id": "123",
    "start_month": "2024-01",
    "end_month": "2026-09",
    "include_payroll": true,
    "compare_cpi": true
  }
}
```

`employee_id` es el ID numérico de la ficha, no el RUT. Buk documenta que consultar
por RUT puede seleccionar únicamente la Ficha 1. Una persona con varias fichas se
debe identificar y consultar sin perder sus registros.

La cobertura informa los meses solicitados, los meses con liquidación y los meses
sin liquidaciones o sin trabajos vigentes. Un mes ausente no se reemplaza por un
sueldo de cero y una serie incompleta no se marca como completa. Las liquidaciones
abiertas o sin estado conocido se muestran como provisionales.

Los sueldos base contractuales y los montos de las liquidaciones aparecen en series
separadas. Un bono, una jornada distinta o una liquidación parcial no se etiqueta
como aumento del sueldo base. El historial de trabajos es el historial que expone
Buk; no se promete que contenga cada edición retroactiva de un campo.

Para IPC se utiliza la [serie histórica empalmada del INE](https://www.ine.gob.cl/estadisticas-por-tema/precios-e-inflacion/indice-de-precios-al-consumidor), base 2023=100:

```text
variación nominal = sueldo_final / sueldo_inicial - 1
variación IPC     = índice_final / índice_inicial - 1
variación real    = (sueldo_final / sueldo_inicial) / (índice_final / índice_inicial) - 1
```

No se suman porcentajes mensuales ni se resta simplemente IPC al aumento nominal.
Se usan exactamente los meses solicitados y salarios vigentes al cierre de esos
meses. Si el IPC del mes final aún no está publicado, la comparación explica que no
se puede completar; no usa otro mes silenciosamente.

La descarga del INE contiene índices publicados con dos decimales. Puede haber
diferencias pequeñas respecto de la calculadora oficial que utiliza precisión
interna. El resultado describe esta precisión. El servidor descarga solo datos
públicos del INE: nunca envía nombres, IDs de colaboradores ni importes salariales.

La serie se actualiza desde una URL fija del INE y se mantiene en caché por seis
horas. Si no puede descargarse, se utiliza una copia pública incluida en el repo,
recuperada el **23 de octubre de 2026**, que cubre diciembre de 2009 a septiembre de
2026. Se informa `fallback=true`, la fecha de recuperación original y el último mes
disponible. Esta copia no contiene datos de clientes Buk.

## Qué cubren las pruebas

Las pruebas unitarias usan datos sintéticos y verifican, entre otros casos:
fórmula del costo empresa; asignación familiar; ausencia de aportes; conciliación;
dobles fichas; monedas separadas; liquidaciones repetidas; movimientos históricos;
traslados dentro del mes; centros de costo sin doble ponderación; períodos abiertos;
paginación incompleta; salario real frente a IPC; límites de cobertura del IPC y
caída de la fuente externa. Las pruebas con una cuenta real deben informar sus
resultados sin publicar datos personales ni salarios en el repositorio.
