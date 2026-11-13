package com.aliyun.autowonder.executor;

import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.util.List;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

class BundledExecutorRuntimeControllerTest {
    @Test
    void servesOnlyTheBundledJavascriptModules() throws Exception {
        var mvc = MockMvcBuilders.standaloneSetup(new BundledExecutorRuntimeController()).build();
        for (String module : List.of("executor.mjs", "capsule.mjs", "engine.mjs")) {
            mvc.perform(get(BundledExecutorRuntime.ROUTE + module))
                    .andExpect(status().isOk())
                    .andExpect(header().string("X-Content-Type-Options", "nosniff"))
                    .andExpect(content().contentTypeCompatibleWith("application/javascript"));
        }
        mvc.perform(get(BundledExecutorRuntime.ROUTE + "application.yml"))
                .andExpect(status().isNotFound());
    }
}
