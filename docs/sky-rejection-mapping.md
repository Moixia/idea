# Sky Rejection System — Mapeo Bash / Glob / Grep → MCP

> Objetivo: rechazar automáticamente llamadas exploratorias a Bash, Glob y Grep,
> y decirle a la IA "use MCP instead". Este documento enumera **qué** rechazar
> y **por qué** MCP lo reemplaza.

---

## 1. MCP Tools (Lander) — Referencia rápida

| # | Tool | ¿Qué hace? |
|---|------|-----------|
| 1 | `list_projects` | Lista proyectos indexados |
| 2 | `index_repository` | Indexa un repo en el grafo |
| 3 | `index_status` | Progreso de indexación |
| 4 | `get_graph_schema` | Tipos de nodos/aristas disponibles |
| 5 | `search_graph` | Busca funciones, clases, rutas por nombre/patrón/semántica |
| 6 | `search_code` | Grep enriquecido con metadatos del grafo |
| 7 | `get_code_snippet` | Código fuente de un símbolo por qualified_name |
| 8 | `trace_path` | Call graph: quién llama a quién, flujo de datos |
| 9 | `query_graph` | Cypher directo para queries complejas |
| 10 | `get_architecture` | Visión general: paquetes, dependencias, clústeres |
| 11 | `detect_changes` | Cambios y análisis de impacto (git) |
| 12 | `manage_adr` | Architecture Decision Records |
| 13 | `ingest_traces` | Ingestar traces de ejecución |
| 14 | `delete_project` | Eliminar proyecto del índice |

---

## 2. Bash — comandos a rechazar (exploración)

> **Regla**: Bash es para **ejecución** (builds, tests, scripts, git ops, networking).
> Nunca para **exploración** de código. Si el comando existe solo para ver qué hay,
> se rechaza.

### 2.1 Comandos de navegación / inspección → MCP

| Bash | Patrón típico | MCP replacement |
|------|--------------|----------------|
| `ls` | `ls`, `ls -la`, `ls -R`, `ls dir/` | `get_architecture(project)` — estructura del proyecto |
| | | `search_graph(file_pattern="dir/**")` — archivos en directorio |
| `tree` | `tree`, `tree -L 2` | `get_architecture(project)` — árbol completo |
| `find` | `find . -name "*.ts"` | `search_graph(file_pattern="**/*.ts")` |
| | `find . -type f -name "*.py"` | `search_graph(file_pattern="**/*.py", label="File")` |
| | `find . -size +1M` | No aplica (no exploración de código) |
| `du` | `du -sh *`, `du -h` | No aplica (esto es sistema, no código) |
| `df` | `df -h` | No aplica (sistema) |
| `stat` | `stat file.ts` | `search_graph(file_pattern="file.ts")` — da metadatos |

### 2.2 Comandos de lectura → MCP

| Bash | Patrón típico | MCP replacement |
|------|--------------|----------------|
| `cat` | `cat file.ts` | `get_code_snippet(qualified_name="...")` |
| | `cat src/**/*.ts` (exploratorio) | `search_graph(file_pattern="src/**/*.ts")` + `get_code_snippet` |
| `head` | `head -50 file.ts` | `get_code_snippet` (lee exactamente el símbolo) |
| `tail` | `tail -100 file.ts` | `get_code_snippet` |
| `wc -l` | `wc -l src/**/*.ts` | `search_graph` (metadata de líneas por símbolo) |
| `nl`, `cat -n` | `nl file.ts` | `get_code_snippet` |

### 2.3 Comandos de búsqueda en texto → MCP

| Bash | Patrón típico | MCP replacement |
|------|--------------|----------------|
| `grep` | `grep -r "pattern" src/` | `search_code(pattern="pattern", project=...)` |
| | `grep -rn "function" *.ts` | `search_code(pattern="function", file_pattern="*.ts")` |
| | `grep -rl "TODO" src/` | `search_code(pattern="TODO", mode="files")` |
| `rg` | `rg "foo" src/` | `search_code(pattern="foo")` |
| `ag` | `ag "class.*Handler"` | `search_code(pattern="class.*Handler", regex=true)` |
| `ack` | `ack "def "` | `search_code(pattern="def ")` |
| `git grep` | `git grep "pattern"` | `search_code(pattern="pattern")` |

### 2.4 Comandos git para exploración → MCP

| Bash | Patrón típico | MCP replacement |
|------|--------------|----------------|
| `git log --oneline` | `git log --oneline -20` | `detect_changes(project=..., since="HEAD~20")` |
| `git diff` | `git diff HEAD~1` | `detect_changes(project=...)` |
| `git diff --stat` | `git diff --stat HEAD~5` | `detect_changes(project=..., depth=5)` |
| `git show` | `git show abc123` | `detect_changes(project=...)` |
| `git blame` | `git blame file.ts` | `search_graph(file_pattern="file.ts")` + `trace_path` |
| `git log -p` | `git log -p -5` | `detect_changes(depth=5)` |

### 2.5 Otros comandos exploratorios → MCP

| Bash | Patrón típico | MCP replacement |
|------|--------------|----------------|
| `which` | `which node` | No aplica (no es código del proyecto) |
| `type` | `type function_name` | `search_graph(name_pattern=".*function_name.*")` |
| `declare -f` | `declare -f func` | `get_code_snippet(qualified_name="...")` |

### 2.6 Comandos que NO se rechazan (ejecución válida)

```
npm, pnpm, yarn       — builds, tests, install
node, python, deno    — ejecutar scripts
git commit/push/pull  — operaciones git
cp, mv, rm, mkdir     — file management (aunque mejor Write/Edit si aplica)
curl, wget, ping      — networking
tar, gzip, zip        — compresión
docker                — contenedores
npx                   — ejecutar binarios
```

---

## 3. Glob — patrones a rechazar → MCP

> **Regla**: Glob es para encontrar archivos por nombre. Cuando el MCP ya tiene
> el grafo indexado, `search_graph` es más rápido y da más metadata.

### 3.1 Glob estructural (arquitectura)

| Glob | Intención | MCP replacement |
|------|----------|----------------|
| `**/*.ts` | ¿Cuántos .ts hay? | `search_graph(file_pattern="**/*.ts")` |
| `src/**/*.ts` | Archivos en src/ | `search_graph(file_pattern="src/**/*.ts")` |
| `*.{ts,tsx}` | TS/TSX en raíz | `search_graph(file_pattern="*.{ts,tsx}")` |
| `packages/*/package.json` | Todos los packages | `get_architecture(project=...)` |
| `src/**/index.ts` | Entry points | `search_graph(file_pattern="src/**/index.ts")` + `search_graph(label="EntryPoint")` |
| `**/*.test.ts` | Test files | `search_graph(file_pattern="**/*.test.ts")` |
| `**/*.d.ts` | Declaration files | `search_graph(file_pattern="**/*.d.ts")` |
| `src/**/*.yaml` | Config files | `search_code(file_pattern="src/**/*.yaml")` |

### 3.2 Glob por tipo de contenido

| Glob | Intención | MCP replacement |
|------|----------|----------------|
| `src/**/routes/*.ts` | Rutas | `search_graph(label="Route")` |
| `src/**/*Controller*` | Controllers | `search_graph(name_pattern=".*Controller.*")` |
| `src/**/*Service*` | Services | `search_graph(name_pattern=".*Service.*")` |
| `src/**/*Handler*` | Handlers | `search_graph(name_pattern=".*Handler.*")` |
| `src/**/middleware/*` | Middleware | `search_graph(file_pattern="src/**/middleware/*")` |
| `src/**/types/*.ts` | Types | `search_graph(file_pattern="src/**/types/*.ts", label="Type")` |

---

## 4. Grep — patrones a rechazar → MCP

> **Regla**: `Grep` es búsqueda textual plana. `search_code` hace lo mismo pero
> enriquece con estructura del grafo (agrupa por función, ordena por importancia,
> filtra tests, da contexto de imports).

### 4.1 Búsqueda por nombre de símbolo

| Grep | Intención | MCP replacement |
|------|----------|----------------|
| `grep "functionName"` | Encontrar función | `search_graph(name_pattern=".*functionName.*")` |
| `grep "class Handler"` | Encontrar clase | `search_graph(name_pattern=".*Handler.*", label="Class")` |
| `grep "interface Props"` | Encontrar interface | `search_graph(name_pattern=".*Props.*", label="Interface")` |
| `grep "enum Status"` | Encontrar enum | `search_graph(name_pattern=".*Status.*", label="Enum")` |
| `grep "type User"` | Encontrar type | `search_graph(name_pattern=".*User.*", label="Type")` |

### 4.2 Búsqueda de definiciones

| Grep | Intención | MCP replacement |
|------|----------|----------------|
| `grep "def "` (Python) | Definiciones de función | `search_graph(label="Function")` |
| `grep "func "` (Go) | Definiciones de función | `search_graph(label="Function")` |
| `grep "function "` (JS/TS) | Definiciones de función | `search_graph(label="Function")` |
| `grep "class "` | Definiciones de clase | `search_graph(label="Class")` |
| `grep "import "` | Imports | `search_graph(relationship="IMPORTS")` |

### 4.3 Búsqueda de referencias / callers

| Grep | Intención | MCP replacement |
|------|----------|----------------|
| `grep -r "someFunction("` | Quién llama a X | `trace_path(function_name="someFunction", direction="inbound")` |
| `grep -r "new MyClass("` | Quién instancia X | `trace_path(function_name="MyClass", direction="inbound")` |
| `grep -r "import.*from.*x"` | Quién importa X | `search_graph(relationship="IMPORTS")` |

### 4.4 Búsqueda textual

| Grep | Intención | MCP replacement |
|------|----------|----------------|
| `grep -r "TODO"` | Buscar TODOs | `search_code(pattern="TODO", mode="files")` |
| `grep -r "FIXME"` | Buscar FIXMEs | `search_code(pattern="FIXME")` |
| `grep -r "any text"` | Texto arbitrario | `search_code(pattern="any text")` |
| `grep -rn "pattern" --include="*.py"` | Texto en .py | `search_code(pattern="pattern", file_pattern="*.py")` |
| `grep -i "case-insensitive"` | Case insensitive | `search_code(pattern="case-insensitive")` |

### 4.5 Búsqueda de rutas / endpoints

| Grep | Intención | MCP replacement |
|------|----------|----------------|
| `grep "router.get\|@Get\|app.get"` | Rutas HTTP | `search_graph(label="Route")` |
| `grep "express.Router()"` | Routers | `search_graph(label="Route")` |
| `grep "api/v1"` | Endpoints | `search_graph(label="Route")` |

---

## 5. Tabla Resumen — MCP Tool por Situación

| Situación | Lo que NO debes usar | En su lugar usa |
|-----------|---------------------|----------------|
| Entender el repo | `ls`, `tree`, Glob `**/*` | `get_architecture` |
| Encontrar función por nombre | Grep `"funcName"`, Bash `grep -r` | `search_graph(name_pattern=...)` |
| Encontrar clase/símbolo | Grep `"class Foo"`, Glob `*Foo*` | `search_graph(name_pattern=..., label=...)` |
| Ver código de una función | `cat`, `head`, `Read` archivo entero | `get_code_snippet(qualified_name=...)` |
| Quién llama a X | Grep `"X("`, Bash `grep -r "X"` | `trace_path(function_name="X", direction="inbound")` |
| Qué llama X internamente | Grep dentro de X, `Read` del archivo | `trace_path(function_name="X", direction="outbound")` |
| Buscar texto en código | Grep `"pattern"`, Bash `rg "pattern"` | `search_code(pattern=...)` |
| Ver estructura de archivos | `ls -R`, Glob `src/**/*`, `tree` | `get_architecture` + `search_graph` |
| Ver cambios recientes | `git log`, `git diff` | `detect_changes` |
| Entender imports | Grep `"import.*from"` | `search_graph(relationship="IMPORTS")` |
| Encontrar routes/endpoints | Grep `"router."`, `"app.get"` | `search_graph(label="Route")` |
| Ver todos los tests | Glob `**/*.test.*` | `search_graph(file_pattern="**/*.test.*")` |

---

## 6. Reglas de Rechazo — Implementación Lógica

### 6.1 Rechazo en Bash

Detectar si `command` coincide con **cualquier** patrón exploratorio:

```
PATRONES_RECHAZADOS = [
  # Navegación
  /^ls\b/, /^tree\b/, /^find\b/,
  /^stat\b/, /^du\b/, /^df\b/,
  # Lectura exploratoria
  /^cat\b/, /^head\b/, /^tail\b/, /^wc\b/,
  # Búsqueda en texto
  /^grep\b/, /^rg\b/, /^ag\b/, /^ack\b/,
  /^git grep\b/, /^git log\b/, /^git diff\b/,
  /^git show\b/, /^git blame\b/,
  # Shell
  /^which\b/, /^type\b/,
]
```

**Respuesta de rechazo:**
```
⛔ Bash no es para exploración. Usá MCP.
  {comando} → {mcp_tool}({parametros})
```

### 6.2 Rechazo en Glob

Detectar si `pattern` pide estructura del código (no files concretos conocidos):

```
PATRONES_EXPLORATORIOS = [
  # Demasiado amplio
  "**/*", "**/*.*",
  # Anchor sin archivo específico
  /^src\/\*\*\//, /^packages\/\*\*\//,
  # Búsqueda por extensión (exploratoria)
  /^\*\*\/\*\.\w+$/,
  /^src\/\*\*\/\*\.\w+$/,
  # Búsqueda por nombre genérico
  /\*Controller\*/, /\*Service\*/, /\*Handler\*/,
  /\*Impl\*/, /\*Util\*/, /\*Helper\*/,
  # Búsqueda de entry points
  /\*\/index\.ts$/, /\*\/index\.js$/,
]
```

**Respuesta de rechazo:**
```
⛔ Glob no es para explorar estructura. Usá MCP.
  {pattern} → search_graph(file_pattern="{pattern}", project=...)
  Si buscás el esquema del proyecto: get_architecture(project=...)
```

### 6.3 Rechazo en Grep

Detectar si `pattern` es búsqueda de símbolos o estructura:

```
PATRONES_SIMBOLICOS = [
  # Definiciones
  /^function\b/, /^class\b/, /^interface\b/,
  /^type\b/, /^enum\b/, /^def\b/, /^func\b/,
  # Imports
  /^import\b/, /^from\b/, /^require\(/,
  # Rutas
  /router\./, /app\.(get|post|put|delete)/,
  /@(Get|Post|Put|Delete)/,
  # Referencias a funciones conocidas (por longitud del nombre)
  // cualquier patrón que parezca un identifier de código
]
```

**Respuesta de rechazo:**
```
⛔ Grep no es para encontrar símbolos o estructura. Usá MCP.
  Búsqueda textual → search_code(pattern="{pattern}", project=...)
  Búsqueda de símbolo → search_graph(name_pattern=".*{pattern}.*", project=...)
  Call graph → trace_path(function_name="{pattern}", project=...)
```

### 6.4 Excepciones — No rechazar

Estos casos NO se rechazan porque son ejecución, no exploración:

**Bash:**
- Build/test: `npm build`, `pnpm test`, `npx vitest`
- Git ops: `git commit`, `git push`, `git pull`, `git checkout`, `git merge`, `git branch`, `git stash`
- File management: `cp file dest`, `mv file dest`, `mkdir dir`, `rm file`
- Compresión: `tar -czf`, `zip -r`
- Networking: `curl https://...`, `wget https://...`
- Package management: `npm install`, `pnpm add`, `pnpm remove`
- Ejecución: `node script.js`, `python script.py`
- Procesos: `ps aux`, `kill`, `top` (sistema, no código)

**Glob:**
- Patrones para archivos específicos que ya se sabe que existen:
  `packages/agent-core/src/**/*.ts` (cuando ya se identificó el archivo vía MCP)
- Lectura de un path concreto conocido: `ls packages/agent-core/`

**Grep:**
- Búsqueda de texto verdaderamente arbitrario (no símbolos):
  `"TODO"`, `"FIXME"`, `"HACK"`, `"error message"`, `"deprecated"`

---

## 7. Prioridad de Implementación

| Prioridad | Área | Impacto | # de rechazos esperados |
|-----------|------|---------|------------------------|
| P0 | `ls`, `find`, `tree` en Bash | Muy alto | ~40% de falsos usos |
| P0 | `grep`/`rg` para buscar funciones | Muy alto | ~30% de falsos usos |
| P1 | Glob `**/*.{ts,js,py}` | Alto | ~15% de falsos usos |
| P1 | `cat`/`head`/`Read` exploratorio | Alto | ~10% de falsos usos |
| P2 | `git log`/`git diff` exploratorio | Medio | ~3% de falsos usos |
| P2 | `wc -l`, `stat` | Bajo | ~2% de falsos usos |

---

## 8. Mensaje de Rechazo Estándar

```
⛌ {TOOL} no es para exploración de código.

  Lo que intentaste: {comando}
  ─────────────────────────────────────────────
  Usá MCP en su lugar:

  {sugerencia 1}
  {sugerencia 2}
  ...

  Bash/Glob/Grep solo están disponibles para:
  • Ejecutar builds, tests, y scripts
  • Operaciones git (commit, push, pull)
  • File management (cp, mv, mkdir)
  • Networking (curl, wget)
  • Búsqueda de texto verdaderamente arbitrario (TODOs, strings)
```

---

*Fin del informe.*
