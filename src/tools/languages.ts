export interface LanguageEntry {
    id: string;
    label: string;
    extensions: string[];
    projectFiles: string[];
    nativeCheck?: {
        command: string;
        binary: string;
    };
    treeSitterWasmUrl: string | null;
}

const UNPKG = "https://unpkg.com";

export const LANGUAGES: LanguageEntry[] = [
    {
        id: "typescript",
        label: "TypeScript",
        extensions: [".ts", ".tsx"],
        projectFiles: ["tsconfig.json"],
        nativeCheck: { command: "npx tsc --noEmit", binary: "npx" },
        treeSitterWasmUrl: `${UNPKG}/tree-sitter-typescript@latest/tree-sitter-typescript.wasm`
    },
    {
        id: "javascript",
        label: "JavaScript",
        extensions: [".js", ".jsx", ".mjs", ".cjs"],
        projectFiles: ["package.json"],
        nativeCheck: { command: "npx tsc --noEmit --allowJs --checkJs", binary: "npx" },
        treeSitterWasmUrl: `${UNPKG}/tree-sitter-javascript@latest/tree-sitter-javascript.wasm`
    },
    {
        id: "go",
        label: "Go",
        extensions: [".go"],
        projectFiles: ["go.mod"],
        nativeCheck: { command: "go build ./...", binary: "go" },
        treeSitterWasmUrl: `${UNPKG}/tree-sitter-go@latest/tree-sitter-go.wasm`
    },
    {
        id: "python",
        label: "Python",
        extensions: [".py"],
        projectFiles: ["pyproject.toml", "requirements.txt", "setup.py"],
        nativeCheck: { command: "python3 -m compileall .", binary: "python3" },
        treeSitterWasmUrl: `${UNPKG}/tree-sitter-python@latest/tree-sitter-python.wasm`
    },
    {
        id: "rust",
        label: "Rust",
        extensions: [".rs"],
        projectFiles: ["Cargo.toml"],
        nativeCheck: { command: "cargo check 2>&1", binary: "cargo" },
        treeSitterWasmUrl: `${UNPKG}/tree-sitter-rust@latest/tree-sitter-rust.wasm`
    },
    {
        id: "c",
        label: "C",
        extensions: [".c", ".h"],
        projectFiles: ["Makefile", "CMakeLists.txt", "meson.build"],
        treeSitterWasmUrl: `${UNPKG}/tree-sitter-c@latest/tree-sitter-c.wasm`
    },
    {
        id: "cpp",
        label: "C++",
        extensions: [".cpp", ".cc", ".cxx", ".hpp", ".hxx"],
        projectFiles: ["CMakeLists.txt", "meson.build"],
        treeSitterWasmUrl: `${UNPKG}/tree-sitter-cpp@latest/tree-sitter-cpp.wasm`
    },
    {
        id: "java",
        label: "Java",
        extensions: [".java"],
        projectFiles: ["pom.xml", "build.gradle", "build.gradle.kts"],
        nativeCheck: { command: "javac -version", binary: "javac" },
        treeSitterWasmUrl: `${UNPKG}/tree-sitter-java@latest/tree-sitter-java.wasm`
    },
    {
        id: "ruby",
        label: "Ruby",
        extensions: [".rb"],
        projectFiles: ["Gemfile"],
        nativeCheck: { command: "ruby -c .", binary: "ruby" },
        treeSitterWasmUrl: `${UNPKG}/tree-sitter-ruby@latest/tree-sitter-ruby.wasm`
    },
    {
        id: "csharp",
        label: "C#",
        extensions: [".cs"],
        projectFiles: ["*.csproj", "*.sln"],
        nativeCheck: { command: "dotnet build 2>&1", binary: "dotnet" },
        treeSitterWasmUrl: `${UNPKG}/tree-sitter-c-sharp@latest/tree-sitter-c_sharp.wasm`
    },
    {
        id: "php",
        label: "PHP",
        extensions: [".php"],
        projectFiles: ["composer.json"],
        nativeCheck: { command: "php -l .", binary: "php" },
        treeSitterWasmUrl: `${UNPKG}/tree-sitter-php@latest/tree-sitter-php.wasm`
    },
    {
        id: "swift",
        label: "Swift",
        extensions: [".swift"],
        projectFiles: ["Package.swift"],
        nativeCheck: { command: "swift build", binary: "swift" },
        treeSitterWasmUrl: `${UNPKG}/tree-sitter-swift@latest/tree-sitter-swift.wasm`
    },
    {
        id: "lua",
        label: "Lua",
        extensions: [".lua"],
        projectFiles: [],
        nativeCheck: { command: "luac -p $(find . -name '*.lua')", binary: "luac" },
        treeSitterWasmUrl: `${UNPKG}/tree-sitter-lua@latest/tree-sitter-lua.wasm`
    },
    {
        id: "dart",
        label: "Dart / Flutter",
        extensions: [".dart"],
        projectFiles: ["pubspec.yaml", "pubspec.yml"],
        nativeCheck: { command: "dart analyze", binary: "dart" },
        treeSitterWasmUrl: `${UNPKG}/tree-sitter-dart@latest/tree-sitter-dart.wasm`
    },
    {
        id: "kotlin",
        label: "Kotlin",
        extensions: [".kt", ".kts"],
        projectFiles: ["build.gradle.kts", "settings.gradle.kts"],
        nativeCheck: { command: "kotlinc -version", binary: "kotlinc" },
        treeSitterWasmUrl: `${UNPKG}/tree-sitter-kotlin@latest/tree-sitter-kotlin.wasm`
    },
    {
        id: "scala",
        label: "Scala",
        extensions: [".scala", ".sc"],
        projectFiles: ["build.sbt", "build.sc"],
        nativeCheck: { command: "scalac -version", binary: "scalac" },
        treeSitterWasmUrl: `${UNPKG}/tree-sitter-scala@latest/tree-sitter-scala.wasm`
    },
    {
        id: "elixir",
        label: "Elixir",
        extensions: [".ex", ".exs"],
        projectFiles: ["mix.exs"],
        nativeCheck: { command: "mix compile", binary: "mix" },
        treeSitterWasmUrl: `${UNPKG}/tree-sitter-elixir@latest/tree-sitter-elixir.wasm`
    },
    {
        id: "haskell",
        label: "Haskell",
        extensions: [".hs", ".lhs"],
        projectFiles: ["stack.yaml", "cabal.project", "*.cabal"],
        nativeCheck: { command: "ghc --version", binary: "ghc" },
        treeSitterWasmUrl: `${UNPKG}/tree-sitter-haskell@latest/tree-sitter-haskell.wasm`
    },
    {
        id: "ocaml",
        label: "OCaml",
        extensions: [".ml", ".mli"],
        projectFiles: ["dune-project", "*.opam"],
        nativeCheck: { command: "ocaml --version", binary: "ocaml" },
        treeSitterWasmUrl: `${UNPKG}/tree-sitter-ocaml@latest/tree-sitter-ocaml.wasm`
    },
    {
        id: "r",
        label: "R",
        extensions: [".r", ".R", ".Rmd", ".rmd"],
        projectFiles: ["DESCRIPTION", ".Rproj"],
        nativeCheck: { command: "Rscript --version", binary: "Rscript" },
        treeSitterWasmUrl: `${UNPKG}/tree-sitter-r@latest/tree-sitter-r.wasm`
    },
    {
        id: "julia",
        label: "Julia",
        extensions: [".jl"],
        projectFiles: ["Project.toml", "Manifest.toml"],
        nativeCheck: { command: "julia --version", binary: "julia" },
        treeSitterWasmUrl: `${UNPKG}/tree-sitter-julia@latest/tree-sitter-julia.wasm`
    },
    {
        id: "zig",
        label: "Zig",
        extensions: [".zig"],
        projectFiles: ["build.zig"],
        nativeCheck: { command: "zig build", binary: "zig" },
        treeSitterWasmUrl: `${UNPKG}/tree-sitter-zig@latest/tree-sitter-zig.wasm`
    },
    {
        id: "nim",
        label: "Nim",
        extensions: [".nim", ".nims"],
        projectFiles: ["*.nimble"],
        nativeCheck: { command: "nim check", binary: "nim" },
        treeSitterWasmUrl: `${UNPKG}/tree-sitter-nim@latest/tree-sitter-nim.wasm`
    },
    {
        id: "bash",
        label: "Bash / Shell",
        extensions: [".sh", ".bash", ".zsh", ".fish"],
        projectFiles: [".bashrc", ".zshrc"],
        nativeCheck: { command: "bash --norc -n", binary: "bash" },
        treeSitterWasmUrl: `${UNPKG}/tree-sitter-bash@latest/tree-sitter-bash.wasm`
    },
    {
        id: "sql",
        label: "SQL",
        extensions: [".sql"],
        projectFiles: [],
        treeSitterWasmUrl: `${UNPKG}/tree-sitter-sql@latest/tree-sitter-sql.wasm`
    },
    {
        id: "css",
        label: "CSS",
        extensions: [".css", ".scss", ".sass", ".less"],
        projectFiles: [],
        treeSitterWasmUrl: `${UNPKG}/tree-sitter-css@latest/tree-sitter-css.wasm`
    },
    {
        id: "html",
        label: "HTML",
        extensions: [".html", ".htm"],
        projectFiles: [],
        treeSitterWasmUrl: `${UNPKG}/tree-sitter-html@latest/tree-sitter-html.wasm`
    },
    {
        id: "toml",
        label: "TOML",
        extensions: [".toml"],
        projectFiles: [],
        treeSitterWasmUrl: `${UNPKG}/tree-sitter-toml@latest/tree-sitter-toml.wasm`
    },
    {
        id: "yaml",
        label: "YAML",
        extensions: [".yaml", ".yml"],
        projectFiles: [],
        treeSitterWasmUrl: `${UNPKG}/tree-sitter-yaml@latest/tree-sitter-yaml.wasm`
    },
    {
        id: "json",
        label: "JSON",
        extensions: [".json", ".jsonc"],
        projectFiles: [],
        treeSitterWasmUrl: `${UNPKG}/tree-sitter-json@latest/tree-sitter-json.wasm`
    }
];

export function detectLanguageByProject(
    existingFiles: Set<string>
): LanguageEntry | undefined {
    for (const lang of LANGUAGES) {
        for (const marker of lang.projectFiles) {
            if (existingFiles.has(marker)) {
                return lang;
            }
        }
    }
    return undefined;
}

export function detectLanguageByExtension(ext: string): LanguageEntry | undefined {
    return LANGUAGES.find(l => l.extensions.includes(ext));
}
