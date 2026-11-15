package com.aliyun.autowonder.executor;

import org.springframework.core.io.ClassPathResource;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.regex.Pattern;

final class BundledExecutorRuntime {
    static final String ROUTE = "/executor-runtime/";
    private static final List<String> MODULES = List.of("executor.mjs", "engine.mjs", "capsule.mjs");
    private static final int MAX_MODULE_BYTES = 1024 * 1024;
    private static final String VERSION_PREFIX = "community-";
    private static final int MAX_MODEL_ID_LENGTH = 200;
    private static final String MODEL_ID = "[A-Za-z0-9_.:/+][A-Za-z0-9_.:/+-]*";
    private static final Pattern MODEL_ID_PATTERN = Pattern.compile(MODEL_ID);
    private static final Pattern OPENCODE_MODEL_ID_PATTERN = Pattern.compile(MODEL_ID + "(?:#[A-Za-z0-9_.+-]+)?");

    private BundledExecutorRuntime() {
    }

    static boolean supports(String clientKind) {
        return ExecutorLaunchOptionsService.CLIENT_KIND_CLAUDE_CODE.equals(clientKind)
                || ExecutorLaunchOptionsService.CLIENT_KIND_CODEX_CLI.equals(clientKind)
                || ExecutorLaunchOptionsService.CLIENT_KIND_OPENCODE_CLI.equals(clientKind);
    }

    static ClassPathResource module(String name) {
        return MODULES.contains(name) ? new ClassPathResource("executor-runtime/" + name) : null;
    }

    static List<String> commandPrefix() {
        return Bootstrap.COMMAND_PREFIX;
    }

    static boolean validModel(String provider, String model) {
        Pattern pattern = ExecutorLaunchOptionsService.PROVIDER_OPENCODE.equals(provider)
                ? OPENCODE_MODEL_ID_PATTERN : MODEL_ID_PATTERN;
        return model.length() <= MAX_MODEL_ID_LENGTH && pattern.matcher(model).matches();
    }

    static List<String> reasoningEfforts(String provider) {
        return switch (provider) {
            case ExecutorLaunchOptionsService.PROVIDER_CLAUDE -> List.of("low", "medium", "high", "xhigh", "max");
            case ExecutorLaunchOptionsService.PROVIDER_CODEX -> List.of("none", "minimal", "low", "medium", "high", "xhigh");
            default -> List.of();
        };
    }

    static boolean isBundledVersion(String version) {
        return version != null && version.startsWith(VERSION_PREFIX);
    }

    static String version() {
        return Bootstrap.VERSION;
    }

    private static String digest(byte[] content) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(content));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }

    private static String moduleDigest(String name) {
        try (var stream = module(name).getInputStream()) {
            byte[] content = stream.readNBytes(MAX_MODULE_BYTES + 1);
            if (content.length == 0 || content.length > MAX_MODULE_BYTES) {
                throw new IllegalStateException("Invalid bundled executor module size: " + name);
            }
            return digest(content);
        } catch (IOException e) {
            throw new IllegalStateException("Cannot load bundled executor module: " + name, e);
        }
    }

    private static final class Bootstrap {
        private static final String MODULE_MANIFEST = String.join(",", MODULES.stream()
                .map(name -> "['" + name + "','" + moduleDigest(name) + "']").toList());
        private static final String VERSION = VERSION_PREFIX + digest(MODULE_MANIFEST.getBytes(StandardCharsets.UTF_8))
                .substring(0, 12);
        private static final List<String> COMMAND_PREFIX = List.of("node", "--input-type=module", "--eval",
                "await import('data:text/javascript;base64," + Base64.getEncoder().encodeToString(
                        source().getBytes(StandardCharsets.UTF_8)) + "')", "--");

        private static String source() {
            return """
                    import { createHash } from 'node:crypto';
                    import { mkdtemp, rm, writeFile } from 'node:fs/promises';
                    import { tmpdir } from 'node:os';
                    import { join } from 'node:path';
                    import { pathToFileURL } from 'node:url';

                    if (Number(process.versions.node.split('.')[0]) < 22) {
                      console.error('Node.js 22 or newer is required');
                      process.exit(1);
                    }
                    const args = process.argv.slice(1);
                    const wsIndex = args.indexOf('--ws-url');
                    let endpoint;
                    try {
                      if (wsIndex >= 0) endpoint = new URL(args[wsIndex + 1]);
                    } catch {
                      // Report an invalid endpoint without exposing any of the supplied arguments.
                    }
                    if (!endpoint || !['ws:', 'wss:'].includes(endpoint.protocol) || endpoint.username || endpoint.password
                        || endpoint.pathname !== '/ws/executor' || endpoint.search || endpoint.hash) {
                      console.error('Invalid executor WebSocket endpoint');
                      process.exit(1);
                    }
                    endpoint.protocol = endpoint.protocol === 'wss:' ? 'https:' : 'http:';
                    const dir = await mkdtemp(join(tmpdir(), 'autowonder-executor-'));
                    try {
                      for (const [name, expected] of [%s]) {
                        const response = await fetch(new URL('%s' + name, endpoint.origin), {
                          redirect: 'error', signal: AbortSignal.timeout(15000),
                        });
                        if (!response.ok || !response.body) throw new Error('Executor module download failed');
                        const chunks = [];
                        let size = 0;
                        for await (const chunk of response.body) {
                          size += chunk.length;
                          if (size > %d) throw new Error('Executor module exceeds the size limit');
                          chunks.push(chunk);
                        }
                        const content = Buffer.concat(chunks, size);
                        if (createHash('sha256').update(content).digest('hex') !== expected) {
                          throw new Error('Executor module changed');
                        }
                        await writeFile(join(dir, name), content, { flag: 'wx', mode: 0o600 });
                      }
                      const { main } = await import(pathToFileURL(join(dir, 'executor.mjs')).href);
                      await main(args, '%s').catch(() => {
                        console.error('Executor could not start. Check its launch settings.');
                        process.exitCode = 1;
                      });
                    } catch {
                      console.error('Executor bundle could not be loaded. Generate a new startup command.');
                      process.exitCode = 1;
                    } finally {
                      await rm(dir, { recursive: true, force: true });
                    }
                    """.formatted(MODULE_MANIFEST, ROUTE, MAX_MODULE_BYTES, VERSION);
        }
    }
}
