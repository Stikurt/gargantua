export function optionalAcceptanceChapterRange(args){
 if(!Array.isArray(args))throw Error('Expected optional start/count arguments');if(!args.length)return undefined;
 if(args.length!==2||args.some(value=>typeof value!=='string'||!/^[1-9][0-9]*$/u.test(value)))throw Error('Provide both chapter start and count as positive integers');
 const [start,count]=args.map(Number);if(!Number.isSafeInteger(start)||start>20000||!Number.isSafeInteger(count)||count>5)throw Error('Chapter start must be1–20000 and count1–5');return {start,count};
}
