import fs from 'node:fs'
import YAML from 'yaml'
import { Plugin_Name, Plugin_Path, isTestRuntime } from './plugin.js'

const _defpath = `${Plugin_Path}/config/xujing.config.def.yaml`;

const userConfigPath = `${Plugin_Path}/config/xujing.config.yaml`;
const configyamlpath = isTestRuntime && !fs.existsSync(userConfigPath) ? _defpath : userConfigPath;

const resourcespath = `${Plugin_Path}/resources/xujing.resources.yaml`;

if (!isTestRuntime && !fs.existsSync(configyamlpath)) {//如果配置不存在，则复制一份默认配置到配置里面
    fs.copyFileSync(`${_defpath}`, `${configyamlpath}`);
}

async function getConfig(name, key) {//获取

    let config = YAML.parse(fs.readFileSync(configyamlpath, 'utf8'));

    if (!config || !config[name] || config[name][key] === undefined || config[name][key] === null) {
        logger.error(`没有设置[${name}]:[${key}],请使用“#虚境重置配置”指令或者前往[${configyamlpath}]设置！`);
        return undefined;
    }
    return config[name][key];

}
async function getresources(name, key) {//获取

    // resources/xujing.resources.yaml 可能不存在(旧版遗留引用), 容错返回 undefined
    if (!fs.existsSync(resourcespath)) {
        logger.error(`资源文件不存在:${resourcespath}`);
        return undefined;
    }

    let resources = YAML.parse(fs.readFileSync(resourcespath, 'utf8'));

    if (!resources || !resources[name] || resources[name][key] === undefined || resources[name][key] === null) {
        logger.error(`没有设置[${name}]:[${key}],请使用“#虚境重置配置”指令或者前往[${resourcespath}]设置！`);
        return undefined;
    }
    return resources[name][key];

}


export default { getConfig ,getresources}
