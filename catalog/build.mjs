// Compact source for the tool catalog. Run `npm run build:catalog` to regenerate catalog/tools.json.
// tier 0: user-space install into .forge/tools (auto)   tier 1: container-only, else needs approval
// tier 2: system-level, needs explicit user approval     tier 3: needs account/credentials
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const T = [];
const add = (o) => T.push({ tier: 0, domains: [], bundles: [], observes: [], controls: [], ...o });
const npm = (id, pkg, bin, summary, o = {}) => add({ id, summary, install: { method: 'npm', pkg, bin, post: o.post || [] }, verify: o.verify ?? (bin ? `${bin} --version` : `node -e "require.resolve('${pkg}')"`), ...o, post: undefined });
const pip = (id, pkg, bin, summary, o = {}) => add({ id, summary, install: { method: 'pip', pkg, bin }, verify: o.verify ?? (bin ? `${bin} --version` : `python -c "import ${o.mod || pkg.replace(/-/g, '_')}"`), ...o, mod: undefined });
const sys = (id, bin, summary, cmds, o = {}) => add({ id, summary, tier: 2, install: { method: 'system', bin, cmds, manual: o.manual }, verify: o.verify ?? `${bin} --version`, ...o, manual: undefined });
const builtin = (id, bin, summary, o = {}) => add({ id, summary, install: { method: 'builtin', bin }, verify: o.verify ?? `${bin} --version`, ...o });
const apt = (pkg) => ({ linux: `sudo apt-get install -y ${pkg}` });
const aptbrew = (pkg, brew = pkg) => ({ linux: `sudo apt-get install -y ${pkg}`, darwin: `brew install ${brew}` });
const brew = (pkg) => ({ darwin: `brew install ${pkg}`, linux: `brew install ${pkg}` });

// ---------- core ----------
builtin('git', 'git', 'Version control; every round is committed.', { domains: ['core'], bundles: ['core'], controls: ['history', 'rollback'] });
builtin('node', 'node', 'Node.js runtime (forge itself needs it).', { domains: ['core'], bundles: ['core'] });
builtin('curl', 'curl', 'HTTP requests from the shell.', { domains: ['core', 'api'], bundles: ['core', 'api-pro'], observes: ['http-response'], controls: ['http'] });

// ---------- web / frontend ----------
npm('playwright', 'playwright', 'playwright', 'Headless browser: screenshots, console/network logs, full UI control.', { post: ['playwright install chromium'], domains: ['web'], bundles: ['web-pro', 'game-pro', 'docs-pro'], observes: ['screenshot', 'console', 'network', 'dom'], controls: ['click', 'type', 'navigate'], notes: 'If the browser fails to launch on Linux: playwright install-deps (needs sudo).' });
npm('vitest', 'vitest', 'vitest', 'Unit/integration test runner for JS/TS.', { domains: ['web', 'test'], bundles: ['web-pro'], observes: ['test-results', 'coverage'] });
npm('jest', 'jest', 'jest', 'JS test runner.', { domains: ['web', 'test'], bundles: ['web-pro'], observes: ['test-results'] });
npm('eslint', 'eslint', 'eslint', 'JS/TS linter.', { domains: ['quality'], bundles: ['web-pro', 'api-pro'], observes: ['lint'] });
npm('prettier', 'prettier', 'prettier', 'Code formatter.', { domains: ['quality'], bundles: ['web-pro', 'api-pro'], controls: ['format'] });
npm('stylelint', 'stylelint', 'stylelint', 'CSS linter.', { domains: ['web', 'quality'], bundles: ['web-pro'], observes: ['lint'] });
npm('typescript', 'typescript', 'tsc', 'TypeScript compiler and type checker.', { domains: ['quality'], bundles: ['web-pro', 'api-pro'], observes: ['types'] });
npm('lighthouse', 'lighthouse', 'lighthouse', 'Performance, a11y, SEO, best-practice audits (needs a Chrome; playwright chromium works via CHROME_PATH).', { domains: ['web', 'perf'], bundles: ['web-pro'], observes: ['perf-score', 'a11y-score', 'seo-score'], requires: ['playwright'] });
npm('axe', '@axe-core/cli', 'axe', 'Accessibility violations scan (WCAG).', { domains: ['web', 'a11y'], bundles: ['web-pro'], observes: ['a11y-violations'], requires: ['playwright'] });
npm('pa11y', 'pa11y', 'pa11y', 'Accessibility testing runner.', { tier: 1, domains: ['web', 'a11y'], bundles: ['web-pro'], observes: ['a11y-violations'], notes: 'Downloads its own Chromium.' });
npm('pixelmatch', 'pixelmatch', null, 'Pixel-diff two screenshots (visual regression).', { domains: ['web', 'visual'], bundles: ['web-pro', 'game-pro'], observes: ['visual-diff'] });
npm('size-limit', 'size-limit', 'size-limit', 'Enforce JS bundle size budgets.', { domains: ['web', 'perf'], bundles: ['web-pro'], observes: ['bundle-size'] });
npm('source-map-explorer', 'source-map-explorer', 'source-map-explorer', 'Treemap of what is inside a JS bundle.', { domains: ['web', 'perf'], bundles: ['web-pro'], observes: ['bundle-composition'] });
npm('webpack-bundle-analyzer', 'webpack-bundle-analyzer', 'webpack-bundle-analyzer', 'Interactive bundle size analysis.', { domains: ['web', 'perf'], bundles: ['web-pro'], observes: ['bundle-composition'] });
npm('knip', 'knip', 'knip', 'Find unused files, exports, and dependencies.', { domains: ['quality'], bundles: ['web-pro', 'api-pro'], observes: ['dead-code'] });
npm('dependency-cruiser', 'dependency-cruiser', 'depcruise', 'Dependency graph rules and cycle detection.', { domains: ['quality'], bundles: ['web-pro', 'api-pro'], observes: ['dependency-graph'] });
npm('madge', 'madge', 'madge', 'Circular dependency finder.', { domains: ['quality'], bundles: ['web-pro'], observes: ['cycles'] });
npm('jscpd', 'jscpd', 'jscpd', 'Copy-paste (duplication) detector.', { domains: ['quality'], bundles: ['web-pro', 'api-pro'], observes: ['duplication'] });
npm('stryker', '@stryker-mutator/core', 'stryker', 'Mutation testing: do the tests actually catch bugs?', { domains: ['test', 'quality'], bundles: ['web-pro', 'api-pro'], observes: ['mutation-score'] });
npm('fast-check', 'fast-check', null, 'Property-based testing for JS/TS.', { domains: ['test'], bundles: ['web-pro', 'api-pro'], observes: ['property-tests'] });
npm('style-dictionary', 'style-dictionary', 'style-dictionary', 'Design tokens to platform outputs.', { domains: ['design'], bundles: ['web-pro'], controls: ['design-tokens'] });
npm('i18next-parser', 'i18next-parser', 'i18next', 'Extract i18n keys; find missing translations.', { domains: ['i18n'], bundles: ['web-pro'], observes: ['i18n-coverage'] });
npm('svgo', 'svgo', 'svgo', 'SVG optimizer.', { domains: ['assets'], bundles: ['web-pro'], controls: ['svg-optimize'] });
npm('sharp', 'sharp-cli', 'sharp', 'Fast image resize/convert/optimize.', { domains: ['assets', 'media'], bundles: ['web-pro', 'media-pro'], controls: ['image-process'] });
npm('wrangler', 'wrangler', 'wrangler', 'Cloudflare Workers/Pages deploy.', { tier: 3, domains: ['deploy'], bundles: ['devops-pro'], controls: ['deploy'], requires_env: ['CLOUDFLARE_API_TOKEN'] });
npm('vercel', 'vercel', 'vercel', 'Vercel deploy.', { tier: 3, domains: ['deploy'], bundles: ['devops-pro'], controls: ['deploy'], requires_env: ['VERCEL_TOKEN'] });

// ---------- API / backend ----------
pip('httpie', 'httpie', 'http', 'Human-friendly HTTP client.', { domains: ['api'], bundles: ['api-pro'], observes: ['http-response'], controls: ['http'] });
npm('newman', 'newman', 'newman', 'Run Postman collections.', { domains: ['api', 'test'], bundles: ['api-pro'], observes: ['api-test-results'] });
pip('schemathesis', 'schemathesis', 'schemathesis', 'Property-based API testing from OpenAPI/GraphQL schemas.', { domains: ['api', 'test'], bundles: ['api-pro'], observes: ['api-conformance', 'api-fuzz'] });
npm('spectral', '@stoplight/spectral-cli', 'spectral', 'Lint OpenAPI/AsyncAPI documents.', { domains: ['api', 'quality'], bundles: ['api-pro'], observes: ['openapi-lint'] });
npm('redocly', '@redocly/cli', 'redocly', 'OpenAPI lint, bundle, and docs.', { domains: ['api', 'docs'], bundles: ['api-pro', 'docs-pro'], observes: ['openapi-lint'], controls: ['api-docs'] });
npm('autocannon', 'autocannon', 'autocannon', 'HTTP load generator.', { domains: ['api', 'perf'], bundles: ['api-pro'], observes: ['latency', 'throughput'], controls: ['load'] });
pip('locust', 'locust', 'locust', 'Scriptable load testing.', { domains: ['api', 'perf'], bundles: ['api-pro'], observes: ['latency', 'throughput'], controls: ['load'] });
pip('mitmproxy', 'mitmproxy', 'mitmdump', 'Intercept and inspect HTTP(S) traffic.', { domains: ['api', 'security'], bundles: ['api-pro'], observes: ['traffic'] });
sys('k6', 'k6', 'Modern load testing with thresholds.', brew('k6'), { domains: ['api', 'perf'], bundles: ['api-pro'], observes: ['latency', 'throughput'], controls: ['load'], manual: 'https://grafana.com/docs/k6/latest/set-up/install-k6/' });
sys('grpcurl', 'grpcurl', 'curl for gRPC.', brew('grpcurl'), { domains: ['api'], bundles: ['api-pro'], observes: ['grpc-response'], controls: ['grpc'] });
sys('psql', 'psql', 'PostgreSQL client.', aptbrew('postgresql-client', 'libpq'), { domains: ['db'], bundles: ['api-pro', 'data-pro'], observes: ['db-state'], controls: ['sql'] });
sys('sqlite3', 'sqlite3', 'SQLite CLI.', aptbrew('sqlite3', 'sqlite'), { domains: ['db'], bundles: ['api-pro', 'data-pro'], observes: ['db-state'], controls: ['sql'] });
sys('redis-cli', 'redis-cli', 'Redis client.', aptbrew('redis-tools', 'redis'), { domains: ['db'], bundles: ['api-pro'], observes: ['cache-state'], controls: ['redis'] });
pip('sqlfluff', 'sqlfluff', 'sqlfluff', 'SQL linter/formatter.', { domains: ['db', 'quality'], bundles: ['api-pro', 'data-pro'], observes: ['sql-lint'] });
pip('duckdb', 'duckdb', null, 'In-process analytical SQL; query CSV/Parquet.', { domains: ['db', 'data'], bundles: ['data-pro', 'api-pro'], observes: ['data-queries'], mod: 'duckdb' });

// ---------- security ----------
pip('semgrep', 'semgrep', 'semgrep', 'Static analysis for security and bug patterns.', { domains: ['security'], bundles: ['security-pro', 'web-pro', 'api-pro'], observes: ['sast-findings'] });
pip('bandit', 'bandit', 'bandit', 'Python security linter.', { domains: ['security'], bundles: ['security-pro', 'api-pro'], observes: ['sast-findings'] });
pip('pip-audit', 'pip-audit', 'pip-audit', 'Audit Python dependencies for known vulnerabilities.', { domains: ['security'], bundles: ['security-pro', 'api-pro', 'data-pro'], observes: ['dep-vulns'] });
pip('checkov', 'checkov', 'checkov', 'IaC and Dockerfile misconfiguration scanner.', { domains: ['security', 'devops'], bundles: ['security-pro', 'devops-pro'], observes: ['iac-findings'] });
sys('gitleaks', 'gitleaks', 'Find committed secrets.', brew('gitleaks'), { domains: ['security'], bundles: ['security-pro'], observes: ['secrets'], manual: 'https://github.com/gitleaks/gitleaks#installing' });
sys('trufflehog', 'trufflehog', 'Find and verify leaked credentials.', brew('trufflehog'), { domains: ['security'], bundles: ['security-pro'], observes: ['secrets'], manual: 'https://github.com/trufflesecurity/trufflehog#floppy_disk-installation' });
sys('osv-scanner', 'osv-scanner', 'Dependency vulnerabilities from OSV.dev.', brew('osv-scanner'), { domains: ['security'], bundles: ['security-pro'], observes: ['dep-vulns'], manual: 'https://google.github.io/osv-scanner/installation/' });
sys('trivy', 'trivy', 'Scan images, filesystems, IaC for vulns and misconfig.', brew('trivy'), { domains: ['security'], bundles: ['security-pro', 'devops-pro'], observes: ['vulns', 'iac-findings'], manual: 'https://trivy.dev/latest/getting-started/installation/' });
sys('grype', 'grype', 'Vulnerability scanner for images and SBOMs.', brew('grype'), { domains: ['security'], bundles: ['security-pro'], observes: ['vulns'], manual: 'https://github.com/anchore/grype#installation' });
sys('syft', 'syft', 'Generate an SBOM.', brew('syft'), { domains: ['security', 'legal'], bundles: ['security-pro'], observes: ['sbom'], manual: 'https://github.com/anchore/syft#installation' });
sys('hadolint', 'hadolint', 'Dockerfile linter.', brew('hadolint'), { domains: ['security', 'devops'], bundles: ['security-pro', 'devops-pro'], observes: ['dockerfile-lint'], manual: 'https://github.com/hadolint/hadolint#install' });
sys('zap', 'docker', 'OWASP ZAP baseline scan via Docker.', { linux: 'docker pull ghcr.io/zaproxy/zaproxy:stable', darwin: 'docker pull ghcr.io/zaproxy/zaproxy:stable' }, { tier: 2, domains: ['security', 'web'], bundles: ['security-pro'], observes: ['dast-findings'], verify: 'docker --version', notes: 'Run: docker run -t ghcr.io/zaproxy/zaproxy:stable zap-baseline.py -t <url>' });
sys('nuclei', 'nuclei', 'Template-based vulnerability scanner.', brew('nuclei'), { domains: ['security'], bundles: ['security-pro'], observes: ['dast-findings'], manual: 'https://docs.projectdiscovery.io/tools/nuclei/install' });

// ---------- code quality (Python & general) ----------
pip('ruff', 'ruff', 'ruff', 'Very fast Python linter/formatter.', { domains: ['quality'], bundles: ['api-pro', 'data-pro', 'bots-pro'], observes: ['lint'], controls: ['format'] });
pip('mypy', 'mypy', 'mypy', 'Python static type checker.', { domains: ['quality'], bundles: ['api-pro', 'data-pro', 'bots-pro'], observes: ['types'] });
npm('pyright', 'pyright', 'pyright', 'Fast Python type checker.', { domains: ['quality'], bundles: ['api-pro', 'data-pro'], observes: ['types'] });
pip('pytest', 'pytest', 'pytest', 'Python test runner.', { domains: ['test'], bundles: ['api-pro', 'data-pro', 'bots-pro'], observes: ['test-results'] });
pip('coverage', 'coverage', 'coverage', 'Python test coverage.', { domains: ['test'], bundles: ['api-pro', 'data-pro', 'bots-pro'], observes: ['coverage'] });
pip('hypothesis', 'hypothesis', null, 'Property-based testing for Python.', { domains: ['test'], bundles: ['api-pro', 'data-pro', 'bots-pro'], observes: ['property-tests'] });
pip('mutmut', 'mutmut', 'mutmut', 'Mutation testing for Python.', { domains: ['test', 'quality'], bundles: ['api-pro', 'bots-pro'], observes: ['mutation-score'] });
pip('pre-commit', 'pre-commit', 'pre-commit', 'Git hook runner for linters/formatters.', { domains: ['quality'], bundles: ['core'], controls: ['hooks'] });

// ---------- systems / C++ / embedded ----------
pip('cmake', 'cmake', 'cmake', 'CMake build system (user-space).', { domains: ['systems'], bundles: ['systems-pro'], controls: ['build'] });
pip('ninja', 'ninja', 'ninja', 'Fast build backend.', { domains: ['systems'], bundles: ['systems-pro'], controls: ['build'] });
pip('clang-tidy', 'clang-tidy', 'clang-tidy', 'C/C++ static analysis and style checks.', { domains: ['systems', 'quality'], bundles: ['systems-pro'], observes: ['lint', 'sast-findings'] });
sys('cppcheck', 'cppcheck', 'C/C++ static analyzer.', aptbrew('cppcheck'), { domains: ['systems', 'quality'], bundles: ['systems-pro'], observes: ['sast-findings'] });
sys('gdb', 'gdb', 'GNU debugger.', aptbrew('gdb'), { domains: ['systems'], bundles: ['systems-pro'], observes: ['backtraces', 'state'], controls: ['debug'] });
sys('lldb', 'lldb', 'LLVM debugger.', aptbrew('lldb', 'llvm'), { domains: ['systems'], bundles: ['systems-pro'], observes: ['backtraces', 'state'], controls: ['debug'] });
sys('valgrind', 'valgrind', 'Memory errors and leaks; callgrind profiling.', apt('valgrind'), { domains: ['systems'], bundles: ['systems-pro'], observes: ['memory-errors', 'profile'] });
sys('ccache', 'ccache', 'Compiler cache for faster rebuilds.', aptbrew('ccache'), { domains: ['systems'], bundles: ['systems-pro'], controls: ['build-cache'] });
sys('perf', 'perf', 'Linux CPU profiler.', apt('linux-tools-generic'), { domains: ['systems', 'perf'], bundles: ['systems-pro'], observes: ['cpu-profile'] });
sys('heaptrack', 'heaptrack', 'Heap allocation profiler.', apt('heaptrack'), { domains: ['systems', 'perf'], bundles: ['systems-pro'], observes: ['heap-profile'] });
sys('afl++', 'afl-fuzz', 'Coverage-guided fuzzer.', aptbrew('afl++'), { domains: ['systems', 'security'], bundles: ['systems-pro', 'security-pro'], observes: ['crashes'], controls: ['fuzz'], verify: 'afl-fuzz -h' });
pip('atheris', 'atheris', null, 'Coverage-guided fuzzing for Python.', { domains: ['test', 'security'], bundles: ['security-pro'], observes: ['crashes'], controls: ['fuzz'] });
sys('hyperfine', 'hyperfine', 'Command-line benchmarking with statistics.', aptbrew('hyperfine'), { domains: ['perf'], bundles: ['systems-pro', 'api-pro'], observes: ['benchmarks'] });
pip('platformio', 'platformio', 'pio', 'Embedded build/test/upload across MCUs.', { domains: ['embedded'], bundles: ['systems-pro'], controls: ['embedded-build'], verify: 'pio --version' });
sys('qemu', 'qemu-system-x86_64', 'Machine emulator for firmware/OS testing.', aptbrew('qemu-system', 'qemu'), { domains: ['embedded', 'systems'], bundles: ['systems-pro'], controls: ['emulate'] });
sys('openocd', 'openocd', 'On-chip debugging and flashing.', aptbrew('openocd'), { domains: ['embedded'], bundles: ['systems-pro'], controls: ['flash', 'debug'] });
sys('flamegraph', 'flamegraph', 'Flame graph generation (cargo).', { linux: 'cargo install flamegraph', darwin: 'cargo install flamegraph' }, { domains: ['perf'], bundles: ['systems-pro'], observes: ['cpu-profile'], manual: 'https://github.com/flamegraph-rs/flamegraph' });

// ---------- performance (general) ----------
pip('py-spy', 'py-spy', 'py-spy', 'Sampling profiler for Python.', { domains: ['perf'], bundles: ['api-pro', 'data-pro', 'bots-pro'], observes: ['cpu-profile'] });
npm('clinic', 'clinic', 'clinic', 'Node.js performance diagnostics.', { domains: ['perf'], bundles: ['api-pro'], observes: ['cpu-profile', 'event-loop'] });
npm('0x', '0x', '0x', 'Flamegraphs for Node.js.', { domains: ['perf'], bundles: ['api-pro'], observes: ['cpu-profile'] });

// ---------- mobile / desktop / games ----------
npm('appium', 'appium', 'appium', 'Cross-platform mobile UI automation.', { tier: 1, domains: ['mobile'], bundles: ['mobile-pro'], controls: ['mobile-ui'], observes: ['mobile-screenshot'] });
sys('adb', 'adb', 'Android Debug Bridge: install, logcat, screenshots.', aptbrew('android-tools-adb', 'android-platform-tools'), { domains: ['mobile'], bundles: ['mobile-pro'], observes: ['logcat', 'mobile-screenshot'], controls: ['android'], verify: 'adb version' });
sys('maestro', 'maestro', 'Mobile UI flow testing (YAML flows).', { linux: 'curl -Ls "https://get.maestro.mobile.dev" | bash', darwin: 'curl -Ls "https://get.maestro.mobile.dev" | bash' }, { domains: ['mobile'], bundles: ['mobile-pro'], observes: ['mobile-flows'], controls: ['mobile-ui'] });
sys('xvfb', 'xvfb-run', 'Virtual display for headless GUI apps and games.', apt('xvfb'), { domains: ['desktop', 'game'], bundles: ['game-pro'], controls: ['virtual-display'], verify: 'xvfb-run --help' });
sys('xdotool', 'xdotool', 'Simulate keyboard/mouse input on X11.', apt('xdotool'), { domains: ['desktop', 'game'], bundles: ['game-pro'], controls: ['keyboard', 'mouse'] });
sys('scrot', 'scrot', 'Capture screenshots of an X display.', apt('scrot'), { domains: ['desktop', 'game'], bundles: ['game-pro'], observes: ['screenshot'] });
npm('electron-builder', 'electron-builder', 'electron-builder', 'Package and publish Electron apps.', { domains: ['desktop', 'release'], bundles: ['web-pro'], controls: ['package'] });
pip('pyinstaller', 'pyinstaller', 'pyinstaller', 'Package Python apps as executables.', { domains: ['release'], bundles: ['bots-pro', 'api-pro'], controls: ['package'] });

// ---------- media ----------
sys('ffmpeg', 'ffmpeg', 'Inspect, convert, and extract frames/audio.', aptbrew('ffmpeg'), { domains: ['media'], bundles: ['media-pro', 'game-pro'], observes: ['media-info', 'frames', 'audio'], controls: ['transcode'], verify: 'ffmpeg -version' });
sys('imagemagick', 'convert', 'Image processing and comparison.', aptbrew('imagemagick'), { domains: ['media'], bundles: ['media-pro'], observes: ['image-compare'], controls: ['image-process'], verify: 'convert -version' });
sys('sox', 'sox', 'Audio processing and analysis.', aptbrew('sox'), { domains: ['media'], bundles: ['media-pro'], observes: ['audio-stats'], controls: ['audio-process'] });
sys('tesseract', 'tesseract', 'OCR: read text out of screenshots/images.', aptbrew('tesseract-ocr', 'tesseract'), { domains: ['media', 'visual'], bundles: ['media-pro', 'web-pro'], observes: ['ocr-text'] });
sys('exiftool', 'exiftool', 'Read/write media metadata.', aptbrew('libimage-exiftool-perl', 'exiftool'), { domains: ['media'], bundles: ['media-pro'], observes: ['metadata'] });
pip('opencv', 'opencv-python-headless', null, 'Computer vision: image/frame analysis.', { domains: ['media', 'visual'], bundles: ['media-pro', 'game-pro'], observes: ['image-analysis'], mod: 'cv2' });
pip('faster-whisper', 'faster-whisper', null, 'Speech-to-text: verify spoken audio matches the script.', { tier: 1, domains: ['media'], bundles: ['media-pro'], observes: ['transcript'], mod: 'faster_whisper', notes: 'Downloads model weights on first use.' });

// ---------- data / ML ----------
pip('pandas', 'pandas', null, 'Dataframes and data inspection.', { domains: ['data'], bundles: ['data-pro', 'bots-pro'], observes: ['data-stats'] });
pip('polars', 'polars', null, 'Fast dataframes.', { domains: ['data'], bundles: ['data-pro'], observes: ['data-stats'] });
pip('matplotlib', 'matplotlib', null, 'Plot results to images the supervisor can look at.', { domains: ['data', 'visual'], bundles: ['data-pro', 'bots-pro'], observes: ['plots'] });
pip('plotly', 'plotly', null, 'Interactive plots.', { domains: ['data', 'visual'], bundles: ['data-pro'], observes: ['plots'] });
pip('great-expectations', 'great-expectations', null, 'Declarative data quality checks.', { domains: ['data'], bundles: ['data-pro'], observes: ['data-quality'], mod: 'great_expectations' });
pip('ydata-profiling', 'ydata-profiling', null, 'Automated dataset profiling reports.', { tier: 1, domains: ['data'], bundles: ['data-pro'], observes: ['data-profile'], mod: 'ydata_profiling' });
pip('jupyter-nbconvert', 'nbconvert', 'jupyter-nbconvert', 'Execute and export notebooks.', { domains: ['data'], bundles: ['data-pro'], controls: ['notebooks'] });
pip('mlflow', 'mlflow', 'mlflow', 'Experiment tracking and model registry.', { tier: 1, domains: ['ml'], bundles: ['data-pro'], observes: ['metrics'] });
pip('dvc', 'dvc', 'dvc', 'Data and pipeline versioning.', { domains: ['ml', 'data'], bundles: ['data-pro'], controls: ['data-versioning'] });
pip('onnx', 'onnx', null, 'Model interchange format and checker.', { domains: ['ml'], bundles: ['data-pro'], observes: ['model-validity'] });

// ---------- bots / fintech ----------
npm('ccxt', 'ccxt', null, 'Unified crypto exchange API library (JS).', { domains: ['trading'], bundles: ['bots-pro'], controls: ['exchange-api'] });
pip('ccxt-py', 'ccxt', null, 'Unified crypto exchange API library (Python). Use sandbox/paper mode.', { domains: ['trading'], bundles: ['bots-pro'], controls: ['exchange-api'], mod: 'ccxt' });
pip('vectorbt', 'vectorbt', null, 'Fast vectorized backtesting.', { tier: 1, domains: ['trading'], bundles: ['bots-pro'], observes: ['backtest-metrics'] });
pip('backtrader', 'backtrader', null, 'Event-driven backtesting framework.', { domains: ['trading'], bundles: ['bots-pro'], observes: ['backtest-metrics'] });

// ---------- devops / infra ----------
sys('docker', 'docker', 'Containers: build, run, isolate.', { linux: 'curl -fsSL https://get.docker.com | sh', darwin: 'brew install --cask docker' }, { domains: ['devops'], bundles: ['devops-pro', 'api-pro'], controls: ['containers'], manual: 'https://docs.docker.com/engine/install/' });
sys('kubectl', 'kubectl', 'Kubernetes client.', { linux: 'sudo snap install kubectl --classic', darwin: 'brew install kubectl' }, { domains: ['devops'], bundles: ['devops-pro'], controls: ['k8s'], verify: 'kubectl version --client' });
sys('helm', 'helm', 'Kubernetes package manager.', { linux: 'sudo snap install helm --classic', darwin: 'brew install helm' }, { domains: ['devops'], bundles: ['devops-pro'], controls: ['k8s'], verify: 'helm version' });
sys('kind', 'kind', 'Local Kubernetes in Docker.', brew('kind'), { domains: ['devops'], bundles: ['devops-pro'], controls: ['k8s'], verify: 'kind version', manual: 'https://kind.sigs.k8s.io/docs/user/quick-start/#installation' });
sys('opentofu', 'tofu', 'Open-source Terraform-compatible IaC.', { linux: 'sudo snap install opentofu --classic', darwin: 'brew install opentofu' }, { domains: ['devops'], bundles: ['devops-pro'], controls: ['iac'], verify: 'tofu version' });
pip('ansible', 'ansible-core', 'ansible', 'Configuration management over SSH.', { tier: 1, domains: ['devops'], bundles: ['devops-pro'], controls: ['config-mgmt', 'ssh'] });
builtin('ssh', 'ssh', 'SSH to a remote server for deploys and log inspection.', { domains: ['devops'], bundles: ['devops-pro'], observes: ['remote-logs', 'remote-state'], controls: ['remote-exec'], verify: 'ssh -V' });
builtin('rsync', 'rsync', 'Sync files to a remote server.', { domains: ['devops'], bundles: ['devops-pro'], controls: ['remote-sync'] });
sys('gh', 'gh', 'GitHub CLI: PRs, issues, releases, Actions.', aptbrew('gh'), { domains: ['devops'], bundles: ['devops-pro'], controls: ['github'], manual: 'https://cli.github.com/' });
sys('act', 'act', 'Run GitHub Actions workflows locally.', brew('act'), { domains: ['devops'], bundles: ['devops-pro'], observes: ['ci-results'], manual: 'https://nektosact.com/installation/' });
sys('flyctl', 'flyctl', 'Fly.io deploys.', { linux: 'curl -L https://fly.io/install.sh | sh', darwin: 'brew install flyctl' }, { tier: 3, domains: ['deploy'], bundles: ['devops-pro'], controls: ['deploy'], requires_env: ['FLY_API_TOKEN'] });
pip('certbot', 'certbot', 'certbot', 'TLS certificates (Let\'s Encrypt).', { tier: 1, domains: ['devops'], bundles: ['devops-pro'], controls: ['tls'] });
pip('opentelemetry', 'opentelemetry-distro', 'opentelemetry-bootstrap', 'Tracing/metrics instrumentation for Python.', { domains: ['observability'], bundles: ['devops-pro', 'api-pro'], observes: ['traces', 'metrics'], verify: 'opentelemetry-bootstrap --help' });
sys('prometheus', 'docker', 'Metrics collection (via Docker).', { linux: 'docker pull prom/prometheus', darwin: 'docker pull prom/prometheus' }, { domains: ['observability'], bundles: ['devops-pro'], observes: ['metrics'], verify: 'docker --version' });
sys('grafana', 'docker', 'Dashboards (via Docker).', { linux: 'docker pull grafana/grafana', darwin: 'docker pull grafana/grafana' }, { domains: ['observability'], bundles: ['devops-pro'], observes: ['dashboards'], verify: 'docker --version' });
sys('uptime-kuma', 'docker', 'Uptime monitoring for deployed services (via Docker).', { linux: 'docker pull louislam/uptime-kuma:1', darwin: 'docker pull louislam/uptime-kuma:1' }, { domains: ['observability'], bundles: ['devops-pro'], observes: ['uptime'], verify: 'docker --version' });

// ---------- docs ----------
pip('mkdocs', 'mkdocs', 'mkdocs', 'Static documentation sites from Markdown.', { domains: ['docs'], bundles: ['docs-pro'], controls: ['docs-site'] });
npm('typedoc', 'typedoc', 'typedoc', 'API docs from TypeScript.', { domains: ['docs'], bundles: ['docs-pro', 'web-pro'], controls: ['docs-site'] });
npm('markdownlint', 'markdownlint-cli', 'markdownlint', 'Markdown linter.', { domains: ['docs', 'quality'], bundles: ['docs-pro'], observes: ['docs-lint'] });
npm('mermaid-cli', '@mermaid-js/mermaid-cli', 'mmdc', 'Render Mermaid diagrams to images.', { tier: 1, domains: ['docs'], bundles: ['docs-pro'], controls: ['diagrams'], notes: 'Downloads its own Chromium.' });
sys('lychee', 'lychee', 'Fast broken-link checker.', brew('lychee'), { domains: ['docs'], bundles: ['docs-pro', 'web-pro'], observes: ['broken-links'], manual: 'https://lychee.cli.rs/installation/' });
sys('vale', 'vale', 'Prose linter (style guides).', brew('vale'), { domains: ['docs'], bundles: ['docs-pro'], observes: ['prose-lint'], manual: 'https://vale.sh/docs/install' });

// ---------- release / legal ----------
npm('semantic-release', 'semantic-release', 'semantic-release', 'Automated versioning and releases.', { domains: ['release'], bundles: ['devops-pro'], controls: ['release'] });
npm('changesets', '@changesets/cli', 'changeset', 'Versioning and changelogs for packages.', { domains: ['release'], bundles: ['devops-pro'], controls: ['release'] });
pip('scancode', 'scancode-toolkit', 'scancode', 'License and copyright detection.', { tier: 1, domains: ['legal'], bundles: ['security-pro'], observes: ['licenses'] });

// ---------- game engines ----------
sys('godot', 'godot', 'Godot engine (headless export/test).', { darwin: 'brew install --cask godot' }, { domains: ['game'], bundles: ['game-pro'], controls: ['engine'], manual: 'https://godotengine.org/download', verify: 'godot --version' });

const bundles = {};
for (const t of T) for (const b of t.bundles) (bundles[b] ||= []).push(t.id);
const ids = new Set();
for (const t of T) { if (ids.has(t.id)) throw new Error('duplicate tool id ' + t.id); ids.add(t.id); }

const here = path.dirname(fileURLToPath(import.meta.url));
fs.writeFileSync(path.join(here, 'tools.json'), JSON.stringify({ version: 1, tools: T }, null, 1) + '\n');
fs.writeFileSync(path.join(here, 'bundles.json'), JSON.stringify(bundles, null, 1) + '\n');
console.log(`catalog: ${T.length} tools, ${Object.keys(bundles).length} bundles`);
