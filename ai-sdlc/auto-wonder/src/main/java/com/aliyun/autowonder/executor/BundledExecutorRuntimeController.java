package com.aliyun.autowonder.executor;

import org.springframework.core.io.Resource;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

/** Serves the three executor modules bundled with this platform release. */
@RestController
class BundledExecutorRuntimeController {
    @GetMapping(BundledExecutorRuntime.ROUTE + "{module}")
    ResponseEntity<Resource> module(@PathVariable("module") String module) {
        Resource resource = BundledExecutorRuntime.module(module);
        if (resource == null || !resource.exists()) {
            return ResponseEntity.notFound().build();
        }
        return ResponseEntity.ok()
                .cacheControl(CacheControl.noCache())
                .header("X-Content-Type-Options", "nosniff")
                .contentType(MediaType.parseMediaType("application/javascript"))
                .body(resource);
    }
}
